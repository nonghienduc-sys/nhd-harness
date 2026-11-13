import argparse, datetime as dt, json, sqlite3, sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")

SCHEMA = """
create table if not exists facts(
  id integer primary key autoincrement,
  subject text not null,
  predicate text not null,
  object text not null,
  valid_from text not null,
  valid_to text,
  observed_at text not null,
  source text,
  locator text,
  confidence real not null default 1.0,
  note text,
  supersedes_id integer,
  foreign key(supersedes_id) references facts(id)
);
create index if not exists idx_facts_sp_time on facts(subject,predicate,valid_from,valid_to);
create index if not exists idx_facts_source on facts(source);
"""

def iso(value, *, date_only=False):
    if value is None or value == "":
        return None
    value = str(value).strip()
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.date().isoformat() if date_only else parsed.isoformat()
    except ValueError:
        try:
            parsed_date = dt.date.fromisoformat(value)
            return parsed_date.isoformat()
        except ValueError as exc:
            raise SystemExit(f"Invalid ISO date/time: {value}") from exc

def open_db(path):
    p = Path(path).resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(p))
    con.row_factory = sqlite3.Row
    con.execute("pragma foreign_keys=on")
    con.executescript(SCHEMA)
    return con

def row_dict(row):
    return {key: row[key] for key in row.keys()}

def add(args):
    con = open_db(args.db)
    valid_from = iso(args.valid_from, date_only=True) or dt.date.today().isoformat()
    valid_to = iso(args.valid_to, date_only=True)
    if valid_to and valid_to < valid_from:
        raise SystemExit("valid_to must be >= valid_from")
    observed_at = iso(args.observed_at) or dt.datetime.now(dt.timezone.utc).isoformat()
    supersedes_id = None
    if args.close_previous:
        previous = con.execute(
            """select * from facts where subject=? and predicate=? and valid_from<=?
               and (valid_to is null or valid_to>=?) order by valid_from desc,id desc limit 1""",
            (args.subject, args.predicate, valid_from, valid_from),
        ).fetchone()
        if previous:
            supersedes_id = int(previous["id"])
            day_before = (dt.date.fromisoformat(valid_from) - dt.timedelta(days=1)).isoformat()
            if day_before >= previous["valid_from"]:
                con.execute("update facts set valid_to=? where id=?", (day_before, supersedes_id))
    cur = con.execute(
        """insert into facts(subject,predicate,object,valid_from,valid_to,observed_at,source,locator,confidence,note,supersedes_id)
           values(?,?,?,?,?,?,?,?,?,?,?)""",
        (args.subject, args.predicate, args.object, valid_from, valid_to, observed_at,
         args.source, args.locator, max(0.0, min(float(args.confidence), 1.0)), args.note, supersedes_id),
    )
    con.commit()
    row = con.execute("select * from facts where id=?", (cur.lastrowid,)).fetchone()
    print(json.dumps({"ok": True, "fact": row_dict(row)}, ensure_ascii=False))

def query(args):
    con = open_db(args.db)
    at = iso(args.at, date_only=True) or dt.date.today().isoformat()
    clauses = ["valid_from<=?", "(valid_to is null or valid_to>=?)"]
    params = [at, at]
    if args.subject:
        clauses.append("subject=?")
        params.append(args.subject)
    if args.predicate:
        clauses.append("predicate=?")
        params.append(args.predicate)
    if args.object:
        clauses.append("object=?")
        params.append(args.object)
    rows = con.execute(
        f"select * from facts where {' and '.join(clauses)} order by subject,predicate,valid_from desc,id desc limit ?",
        (*params, max(1, min(args.limit, 200))),
    ).fetchall()
    print(json.dumps({"at": at, "results": [row_dict(r) for r in rows]}, ensure_ascii=False))

def history(args):
    con = open_db(args.db)
    clauses = []
    params = []
    if args.subject:
        clauses.append("subject=?")
        params.append(args.subject)
    if args.predicate:
        clauses.append("predicate=?")
        params.append(args.predicate)
    where = f"where {' and '.join(clauses)}" if clauses else ""
    rows = con.execute(
        f"select * from facts {where} order by subject,predicate,valid_from,id limit ?",
        (*params, max(1, min(args.limit, 500))),
    ).fetchall()
    print(json.dumps({"results": [row_dict(r) for r in rows]}, ensure_ascii=False))

def sources(args):
    con = open_db(args.db)
    rows = con.execute(
        """select source,count(*) as facts,min(valid_from) as first_valid_from,max(coalesce(valid_to,'9999-12-31')) as last_valid_to
           from facts where source is not null group by source order by facts desc,source limit ?""",
        (max(1, min(args.limit, 200)),),
    ).fetchall()
    print(json.dumps({"results": [row_dict(r) for r in rows]}, ensure_ascii=False))

def status(args):
    con = open_db(args.db)
    total = int(con.execute("select count(*) from facts").fetchone()[0])
    active = int(con.execute("select count(*) from facts where valid_to is null").fetchone()[0])
    sourced = int(con.execute("select count(*) from facts where source is not null and source<>''").fetchone()[0])
    print(json.dumps({"ok": True, "facts": total, "openEndedFacts": active, "factsWithSource": sourced,
                      "mode": "local-sqlite-temporal-provenance-graph-v1"}, ensure_ascii=False))

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="action", required=True)
    for name in ("add", "query", "history", "sources", "status"):
        sp = sub.add_parser(name)
        sp.add_argument("--db", required=True)
        if name == "add":
            sp.add_argument("--subject", required=True)
            sp.add_argument("--predicate", required=True)
            sp.add_argument("--object", required=True)
            sp.add_argument("--valid-from", required=True)
            sp.add_argument("--valid-to")
            sp.add_argument("--observed-at")
            sp.add_argument("--source")
            sp.add_argument("--locator")
            sp.add_argument("--confidence", type=float, default=1.0)
            sp.add_argument("--note")
            sp.add_argument("--close-previous", action="store_true")
        elif name == "query":
            sp.add_argument("--at")
            sp.add_argument("--subject")
            sp.add_argument("--predicate")
            sp.add_argument("--object")
            sp.add_argument("--limit", type=int, default=50)
        elif name == "history":
            sp.add_argument("--subject")
            sp.add_argument("--predicate")
            sp.add_argument("--limit", type=int, default=100)
        elif name == "sources":
            sp.add_argument("--limit", type=int, default=100)
    args = ap.parse_args()
    {"add": add, "query": query, "history": history, "sources": sources, "status": status}[args.action](args)

if __name__ == "__main__":
    main()
