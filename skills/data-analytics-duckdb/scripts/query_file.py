import argparse, json, re
from pathlib import Path
import duckdb

ALLOWED = re.compile(r"^\s*(select|with|describe|summarize|show)\b", re.I)
BLOCKED = re.compile(r"\b(attach|detach|install|load|copy|export|import|insert|update|delete|create|drop|alter|call|pragma)\b", re.I)

def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--query", required=True)
    ap.add_argument("--limit", type=int, default=1000)
    args = ap.parse_args()
    q = args.query.strip()
    if ";" in q or not ALLOWED.search(q) or BLOCKED.search(q):
        raise SystemExit("Only one read-only analytical statement is allowed.")
    p = Path(args.file).resolve()
    if not p.is_file():
        raise SystemExit(f"File not found: {p}")
    con = duckdb.connect(":memory:")
    ext = p.suffix.lower()
    source = sql_literal(str(p))
    if ext in {".csv", ".tsv"}:
        con.execute(f"create view data as select * from read_csv_auto({source})")
    elif ext == ".parquet":
        con.execute(f"create view data as select * from read_parquet({source})")
    elif ext in {".json", ".jsonl", ".ndjson"}:
        con.execute(f"create view data as select * from read_json_auto({source})")
    else:
        raise SystemExit("Supported inputs: CSV, TSV, Parquet, JSON/JSONL.")
    cur = con.execute(q)
    cols = [d[0] for d in cur.description]
    rows = cur.fetchmany(max(1, min(args.limit, 10000)))
    print(json.dumps({"columns": cols, "rows": rows, "returned": len(rows)}, ensure_ascii=False, default=str))

if __name__ == "__main__":
    main()
