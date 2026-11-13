# Excel Professional Workflows

## Editing Path Selection

- Use Excel desktop automation when the task needs calculation, PivotTable/PivotChart refresh, Power Query, Power Pivot, slicers, VBA, external connections, PDF export, or exact chart/dashboard rendering.
- Use `openpyxl` for existing `.xlsx`/`.xlsm` edits where formulas and formatting must be preserved. Use `keep_vba=True` for `.xlsm`.
- Use `xlsxwriter` for creating new polished workbooks from scratch.
- Use `pandas` for data cleanup, reshaping, joins, grouping, and validation before writing back to Excel.

## Quality Checks

- Use `scripts/excel_finalize.py <file.xlsx> --refresh --pdf` when final output needs Excel desktop calculation, data refresh, and PDF rendering.
- Recalculate and check visible formula errors.
- Confirm totals, row counts, reconciliation checks, and named ranges.
- Confirm formulas were not unintentionally converted to static values.
- Refresh PivotTables/Power Query when the workbook depends on them.
- Inspect print areas, freeze panes, filters, hidden sheets/rows/columns, workbook protection, and external links.
- For `.xlsm`, preserve the VBA project and warn before modifying macro behavior.

## Model Design

- Separate inputs, calculations, checks, and outputs.
- Use Excel Tables for growing datasets and structured references.
- Use named ranges for important assumptions.
- Prefer transparent formulas over dense one-cell logic unless `LET` improves readability.
- Include validation checks for imported data, missing lookup keys, duplicate IDs, and date/number type mismatches.

## Dashboard Standards

- Keep the data model separate from presentation sheets.
- Use consistent number formats, labels, and time periods.
- Avoid charts that rely on hidden manual ranges.
- Use slicers/timelines only when they are connected to the intended pivots.
- Confirm exported PDF/print layout before delivery.
