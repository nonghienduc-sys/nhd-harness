"""Project-scoped hybrid RAG bridge. JSON stdin is accepted only from the NHD MCP broker."""
from __future__ import annotations
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

import semantic_store as base
import sqlite_vec

# Reuse one already cached embedding model across project databases to avoid copies.
_Embedding = base.TextEmbedding
def _shared_embedding(*args, **kwargs):
    kwargs["cache_dir"] = os.environ.get("NHD_RAG_MODEL_CACHE") or kwargs.get("cache_dir")
    return _Embedding(*args, **kwargs)
base.TextEmbedding = _shared_embedding

def respond(obj):
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))

def open_read_only(db_path: str):
    # Queries and status must not write schema or metadata.
    db = Path(db_path).resolve()
    con = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    con.enable_load_extension(True)
    sqlite_vec.load(con)
    con.enable_load_extension(False)
    model = base.TextEmbedding(model_name=base.DEFAULT_MODEL,
                               cache_dir=os.environ.get("NHD_RAG_MODEL_CACHE") or str(db.parent / "models"))
    return con, model, int(model.embedding_size)

def add_source(db_path: str, payload: dict) -> dict:
    chunks = payload.get("chunks")
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= 1200:
        raise ValueError("Expected 1..1200 source chunks.")
    source = str(payload["source"])
    if any(not isinstance(row, dict) or not str(row.get("text", "")).strip()
           or len(str(row.get("text", ""))) > 4000 for row in chunks):
        raise ValueError("Invalid chunk text.")
    con, model, dim = base.open_db(db_path, base.DEFAULT_MODEL)
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS indexed_sources (
            source TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
            modified_ms REAL NOT NULL, chunks INTEGER NOT NULL, indexed_at TEXT NOT NULL
        )""")
        old = con.execute("SELECT sha256 FROM indexed_sources WHERE source=?", (source,)).fetchone()
        sha = str(payload["sha256"])
        if old and old[0] == sha:
            return {"ok": True, "unchanged": True, "source": source,
                    "chunks": con.execute("SELECT COUNT(*) FROM chunks WHERE source=?", (source,)).fetchone()[0]}
        # Generate embeddings before changing any existing data.
        embeddings = list(model.embed([str(x["text"]) for x in chunks]))
        if len(embeddings) != len(chunks):
            raise RuntimeError("Embedding count mismatch.")
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        with con:
            for (rowid,) in con.execute("SELECT id FROM chunks WHERE source=?", (source,)).fetchall():
                con.execute("DELETE FROM vec_chunks WHERE rowid=?", (rowid,))
            con.execute("DELETE FROM chunks WHERE source=?", (source,))
            for chunk, embedding in zip(chunks, embeddings):
                cur = con.execute("""INSERT INTO chunks(source,text,created_at,title,page,section,locator,metadata_json)
                    VALUES(?,?,?,?,?,?,?,?)""", (source, str(chunk["text"]), now,
                    str(payload.get("title", "")), chunk.get("page"), chunk.get("section"),
                    str(chunk.get("locator") or source), json.dumps(
                        {"source_sha256": sha, "size_bytes": payload["size_bytes"],
                         "modified_ms": payload["modified_ms"]}, separators=(",", ":"))))
                con.execute("INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)",
                            (int(cur.lastrowid), base.f32(embedding)))
            con.execute("""INSERT INTO indexed_sources(source,sha256,size_bytes,modified_ms,chunks,indexed_at)
                VALUES(?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET
                sha256=excluded.sha256,size_bytes=excluded.size_bytes,
                modified_ms=excluded.modified_ms,chunks=excluded.chunks,indexed_at=excluded.indexed_at""",
                (source, sha, payload["size_bytes"], payload["modified_ms"], len(chunks), now))
        return {"ok": True, "unchanged": False, "source": source,
                "chunks": len(chunks), "dim": dim}
    finally:
        con.close()

def search(db_path: str, query: str, limit: int, max_chars: int) -> dict:
    if not Path(db_path).is_file():
        return {"ok": True, "indexed": False, "results": []}
    con, model, _ = open_read_only(db_path)
    try:
        limit = max(1, min(int(limit), 12))
        vh = base.vector_hits(con, model, query, max(20, limit * 4))
        lh = base.lexical_hits(con, query, max(20, limit * 4))
        vr = {rid: (rank + 1, dist) for rank, (rid, dist) in enumerate(vh)}
        lr = {rid: (rank + 1, score) for rank, (rid, score) in enumerate(lh)}
        scores = []
        for rid in vr.keys() | lr.keys():
            score = (1 / (60 + vr[rid][0]) if rid in vr else 0) + (
                     1.15 / (60 + lr[rid][0]) if rid in lr else 0)
            scores.append((score, rid))
        scores.sort(key=lambda x: (-x[0], x[1]))
        results = []
        left = max(500, min(int(max_chars), 16000))
        for score, rid in scores:
            if len(results) >= limit or left < 120:
                break
            row = base.fetch_chunk(con, rid)
            if row is None:
                continue
            item = base.row_payload(row)
            body = str(item.get("text") or "")[:min(1500, left)]
            left -= len(body)
            item["text"] = body
            item.update({"score": score,
                         "vector_rank": vr[rid][0] if rid in vr else None,
                         "lexical_rank": lr[rid][0] if rid in lr else None})
            results.append(item)
        return {"ok": True, "indexed": True, "method": "hybrid-rrf",
                "query": query, "results": results,
                "vector_candidates": len(vh), "lexical_candidates": len(lh),
                "returned_chars": max_chars - left}
    finally:
        con.close()

def status(db_path: str) -> dict:
    if not Path(db_path).is_file():
        return {"ok": True, "indexed": False, "sources": 0, "chunks": 0}
    con, _, dim = open_read_only(db_path)
    try:
        sources = con.execute("SELECT COUNT(DISTINCT source) FROM chunks").fetchone()[0]
        count = con.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        fts = con.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]
        return {"ok": True, "indexed": True, "sources": sources, "chunks": count,
                "fts_chunks": fts, "fts_consistent": count == fts,
                "dim": dim, "method": "hybrid-rrf"}
    finally:
        con.close()

def open_light(db_path: str, read_only: bool):
    # Manifest/removal never needs the embedding model; do not load or download it.
    db = Path(db_path).resolve()
    con = sqlite3.connect(db.as_uri() + ("?mode=ro" if read_only else ""), uri=True)
    con.row_factory = sqlite3.Row
    con.enable_load_extension(True)
    sqlite_vec.load(con)
    con.enable_load_extension(False)
    return con

def list_sources(db_path: str) -> dict:
    con = open_light(db_path, True)
    try:
        has = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_sources'").fetchone()
        rows = con.execute("SELECT source,sha256,size_bytes,modified_ms,chunks FROM indexed_sources").fetchall() if has else []
        return {"ok": True, "sources": [dict(r) for r in rows]}
    finally:
        con.close()

def remove_source(db_path: str, source: str) -> dict:
    con = open_light(db_path, False)
    try:
        with con:
            ids = [r[0] for r in con.execute("SELECT id FROM chunks WHERE source=?", (source,)).fetchall()]
            for rowid in ids:
                con.execute("DELETE FROM vec_chunks WHERE rowid=?", (rowid,))
            con.execute("DELETE FROM chunks WHERE source=?", (source,))
            has = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_sources'").fetchone()
            if has:
                con.execute("DELETE FROM indexed_sources WHERE source=?", (source,))
        return {"ok": True, "source": source, "removed_chunks": len(ids)}
    finally:
        con.close()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["ingest", "query", "status", "sources", "remove"])
    p.add_argument("--db", required=True)
    p.add_argument("--query", default="")
    p.add_argument("--source", default="")
    p.add_argument("--limit", type=int, default=6)
    p.add_argument("--max-chars", type=int, default=6000)
    args = p.parse_args()
    db = Path(args.db).resolve()
    if args.action != "ingest" and not db.is_file():
        if args.action in ("sources", "remove"):
            respond({"ok": True, "indexed": False, "sources": [], "removed_chunks": 0})
            return
        respond({"ok": True, "indexed": False, "sources": 0, "chunks": 0,
                 "results": [] if args.action == "query" else None})
        return
    if args.action == "ingest":
        payload = json.loads(sys.stdin.buffer.read(2500000).decode("utf-8"))
        respond(add_source(str(db), payload))
    elif args.action == "query":
        respond(search(str(db), args.query, args.limit, args.max_chars))
    elif args.action == "sources":
        respond(list_sources(str(db)))
    elif args.action == "remove":
        if not args.source:
            raise ValueError("--source required")
        respond(remove_source(str(db), args.source))
    else:
        respond(status(str(db)))

if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(json.dumps({"ok": False, "error": type(err).__name__ + ": " + str(err)},
                         ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
