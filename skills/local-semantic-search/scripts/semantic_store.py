import argparse, datetime, json, re, sqlite3, struct, sys
from pathlib import Path
import sqlite_vec
from fastembed import TextEmbedding

DEFAULT_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

def f32(v):
    vals = [float(x) for x in v]
    return struct.pack(f"{len(vals)}f", *vals)

def ensure_column(con, table, name, decl):
    cols = {row[1] for row in con.execute(f"pragma table_info({table})")}
    if name not in cols:
        con.execute(f"alter table {table} add column {name} {decl}")

def ensure_fts(con):
    ensure_column(con, "chunks", "title", "text")
    ensure_column(con, "chunks", "page", "integer")
    ensure_column(con, "chunks", "section", "text")
    ensure_column(con, "chunks", "locator", "text")
    ensure_column(con, "chunks", "metadata_json", "text")
    con.execute("""create virtual table if not exists chunks_fts using fts5(
        text, title, section, source UNINDEXED, locator UNINDEXED,
        content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    )""")
    con.executescript("""
    create trigger if not exists chunks_ai after insert on chunks begin
      insert into chunks_fts(rowid,text,title,section,source,locator)
      values(new.id,new.text,coalesce(new.title,''),coalesce(new.section,''),coalesce(new.source,''),coalesce(new.locator,''));
    end;
    create trigger if not exists chunks_ad after delete on chunks begin
      insert into chunks_fts(chunks_fts,rowid,text,title,section,source,locator)
      values('delete',old.id,old.text,coalesce(old.title,''),coalesce(old.section,''),coalesce(old.source,''),coalesce(old.locator,''));
    end;
    create trigger if not exists chunks_au after update on chunks begin
      insert into chunks_fts(chunks_fts,rowid,text,title,section,source,locator)
      values('delete',old.id,old.text,coalesce(old.title,''),coalesce(old.section,''),coalesce(old.source,''),coalesce(old.locator,''));
      insert into chunks_fts(rowid,text,title,section,source,locator)
      values(new.id,new.text,coalesce(new.title,''),coalesce(new.section,''),coalesce(new.source,''),coalesce(new.locator,''));
    end;
    """)
    chunk_count = int(con.execute("select count(*) from chunks").fetchone()[0])
    fts_count = int(con.execute("select count(*) from chunks_fts").fetchone()[0])
    fts_schema = con.execute("select value from semantic_meta where key='fts_schema'").fetchone()
    if not fts_schema or fts_schema[0] != "1" or chunk_count != fts_count:
        con.execute("insert into chunks_fts(chunks_fts) values('rebuild')")
        con.execute("insert or replace into semantic_meta(key,value) values('fts_schema','1')")

def open_db(path, model_name):
    db_path = Path(path).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    con.enable_load_extension(True)
    sqlite_vec.load(con)
    con.enable_load_extension(False)
    model = TextEmbedding(model_name=model_name, cache_dir=str(db_path.parent / "models"))
    dim = int(model.embedding_size)
    con.execute("create table if not exists semantic_meta(key text primary key, value text not null)")
    meta = dict(con.execute("select key,value from semantic_meta").fetchall())
    if meta and (meta.get("model") != model_name or int(meta.get("dim", "0")) != dim):
        raise SystemExit("Existing DB uses a different embedding model/dimension.")
    con.execute("insert or replace into semantic_meta(key,value) values('model',?),('dim',?)", (model_name, str(dim)))
    con.execute("create table if not exists chunks(id integer primary key autoincrement, source text, text text not null, created_at text not null)")
    ensure_fts(con)
    con.execute(f"create virtual table if not exists vec_chunks using vec0(embedding float[{dim}])")
    con.commit()
    return con, model, dim

def row_payload(row):
    meta = None
    if row["metadata_json"]:
        try:
            meta = json.loads(row["metadata_json"])
        except Exception:
            meta = {"raw": row["metadata_json"]}
    return {
        "id": int(row["id"]), "source": row["source"], "title": row["title"],
        "page": row["page"], "section": row["section"], "locator": row["locator"],
        "metadata": meta, "text": row["text"]
    }

def fetch_chunk(con, rowid):
    return con.execute("select id,source,title,page,section,locator,metadata_json,text from chunks where id=?", (int(rowid),)).fetchone()

def add(args):
    con, model, _ = open_db(args.db, args.model)
    text = args.text
    emb = list(model.embed([text]))[0]
    metadata_json = args.metadata_json
    if metadata_json:
        try:
            metadata_json = json.dumps(json.loads(metadata_json), ensure_ascii=False, separators=(",", ":"))
        except Exception as exc:
            raise SystemExit(f"Invalid --metadata-json: {exc}")
    cur = con.execute("""insert into chunks(source,text,created_at,title,page,section,locator,metadata_json)
        values(?,?,?,?,?,?,?,?)""", (
        args.source, text, datetime.datetime.now(datetime.timezone.utc).isoformat(), args.title,
        args.page, args.section, args.locator, metadata_json
    ))
    rowid = int(cur.lastrowid)
    con.execute("insert into vec_chunks(rowid,embedding) values(?,?)", (rowid, f32(emb)))
    con.commit()
    print(json.dumps({"ok": True, "id": rowid, "source": args.source, "locator": args.locator}, ensure_ascii=False))

def vector_hits(con, model, query, k):
    emb = list(model.embed([query]))[0]
    rows = con.execute("select rowid,distance from vec_chunks where embedding match ? and k = ? order by distance", (f32(emb), max(1, min(k, 100)))).fetchall()
    return [(int(r[0]), float(r[1])) for r in rows]

def fts_query(text):
    tokens = [t for t in re.findall(r"[^\W_]+", text, flags=re.UNICODE) if len(t) >= 2]
    seen = []
    seen_cf = set()
    for token in tokens:
        token = token.replace('"', '')
        cf = token.casefold()
        if token and cf not in seen_cf:
            seen.append(token)
            seen_cf.add(cf)
    return " OR ".join(f'"{t}"' for t in seen[:24])

def lexical_hits(con, query, k):
    q = fts_query(query)
    if not q:
        return []
    try:
        rows = con.execute("""select rowid,bm25(chunks_fts,1.0,0.45,0.35,0.0,0.0) as score
            from chunks_fts where chunks_fts match ? order by score limit ?""", (q, max(1, min(k, 200)))).fetchall()
        return [(int(r[0]), float(r[1])) for r in rows]
    except sqlite3.OperationalError:
        return []

def search(args):
    con, model, _ = open_db(args.db, args.model)
    hits = vector_hits(con, model, args.query, max(1, min(args.limit, 50)))
    out = []
    for rowid, distance in hits:
        row = fetch_chunk(con, rowid)
        if row:
            item = row_payload(row)
            item["distance"] = distance
            out.append(item)
    print(json.dumps({"query": args.query, "method": "vector", "results": out}, ensure_ascii=False))

def hybrid(args):
    con, model, _ = open_db(args.db, args.model)
    limit = max(1, min(args.limit, 50))
    candidate_k = max(limit, min(args.candidate_k, 100))
    vh = vector_hits(con, model, args.query, candidate_k)
    lh = lexical_hits(con, args.query, max(candidate_k, limit * 4))
    vr = {rowid: (rank + 1, dist) for rank, (rowid, dist) in enumerate(vh)}
    lr = {rowid: (rank + 1, score) for rank, (rowid, score) in enumerate(lh)}
    ids = set(vr) | set(lr)
    rrf_k = max(1, args.rrf_k)
    ranked = []
    for rowid in ids:
        score = 0.0
        if rowid in vr:
            score += args.vector_weight / (rrf_k + vr[rowid][0])
        if rowid in lr:
            score += args.lexical_weight / (rrf_k + lr[rowid][0])
        ranked.append((score, rowid))
    ranked.sort(key=lambda x: (-x[0], x[1]))
    out = []
    for score, rowid in ranked[:limit]:
        row = fetch_chunk(con, rowid)
        if not row:
            continue
        item = row_payload(row)
        item.update({
            "rrf_score": score,
            "vector_rank": vr.get(rowid, (None, None))[0],
            "distance": vr.get(rowid, (None, None))[1],
            "lexical_rank": lr.get(rowid, (None, None))[0],
            "bm25": lr.get(rowid, (None, None))[1]
        })
        out.append(item)
    print(json.dumps({
        "query": args.query, "method": "hybrid-rrf", "rrf_k": rrf_k,
        "vector_weight": args.vector_weight, "lexical_weight": args.lexical_weight,
        "vector_candidates": len(vh), "lexical_candidates": len(lh), "results": out
    }, ensure_ascii=False))

def status(args):
    con, model, dim = open_db(args.db, args.model)
    count = con.execute("select count(*) from chunks").fetchone()[0]
    fts_count = con.execute("select count(*) from chunks_fts").fetchone()[0]
    vec_version = con.execute("select vec_version()").fetchone()[0]
    print(json.dumps({
        "ok": True, "model": args.model, "dim": dim, "chunks": count, "fts_chunks": fts_count,
        "sqlite_vec": vec_version, "hybrid": True, "fusion": "reciprocal-rank-fusion"
    }, ensure_ascii=False))

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="action", required=True)
    for name in ("add", "search", "hybrid", "status"):
        sp = sub.add_parser(name)
        sp.add_argument("--db", required=True)
        sp.add_argument("--model", default=DEFAULT_MODEL)
        if name == "add":
            sp.add_argument("--source", default="")
            sp.add_argument("--title", default=None)
            sp.add_argument("--page", type=int, default=None)
            sp.add_argument("--section", default=None)
            sp.add_argument("--locator", default=None)
            sp.add_argument("--metadata-json", default=None)
            sp.add_argument("--text", required=True)
        elif name in ("search", "hybrid"):
            sp.add_argument("--query", required=True)
            sp.add_argument("--limit", type=int, default=5)
            if name == "hybrid":
                sp.add_argument("--candidate-k", type=int, default=30)
                sp.add_argument("--rrf-k", type=int, default=60)
                sp.add_argument("--vector-weight", type=float, default=1.0)
                sp.add_argument("--lexical-weight", type=float, default=1.15)
    args = ap.parse_args()
    {"add": add, "search": search, "hybrid": hybrid, "status": status}[args.action](args)

if __name__ == "__main__":
    main()
