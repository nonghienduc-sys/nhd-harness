---
name: data-analytics-duckdb
description: Analyze large local CSV, Parquet and JSON datasets with DuckDB SQL without loading everything into Excel or pandas memory.
---

# Data Analytics - DuckDB

## Runtime
- Isolated venv: `runtime/duckdb-venv`
- Package pin: `duckdb==1.5.5`
- Helper: `skills/data-analytics-duckdb/scripts/query_file.py`

## When to use
Use for large or multi-file datasets, financial tables, project monitoring data, aggregations, joins, grouping, ranking and anomaly checks that are awkward or slow in Excel.

## Workflow
1. Keep raw data read-only.
2. Use the existing Excel skill for workbook formatting/formulas; use DuckDB for analytical computation.
3. Restrict helper queries to read-only SELECT/WITH/DESCRIBE/SUMMARIZE/SHOW statements.
4. Save materialized results as a new CSV/Parquet file; never overwrite the source unless explicitly requested.
5. Reconcile totals and row counts against source files before using results in an official report.

## Example
```powershell
& "runtime\duckdb-venv\Scripts\python.exe" "skills\data-analytics-duckdb\scripts\query_file.py" --file "data.csv" --query "select district, sum(amount) total from data group by district order by total desc"
```
