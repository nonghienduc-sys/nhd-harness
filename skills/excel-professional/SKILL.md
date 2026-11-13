---
name: excel-professional
description: Professional Microsoft Excel workbook creation, editing, auditing, analysis, and training for .xlsx, .xlsm, .xlsb, .csv, and spreadsheet workflows. Use when Codex needs to work with Excel or Vietnamese requests such as sua file Excel, kiem tra cong thuc, bang tinh, PivotTable, Power Query, dashboard, bieu do, macro VBA, luyen Excel, bai test Excel kho. Handles formulas, tables, PivotTables, PivotCharts, Power Query, Power Pivot, dashboards, data validation, conditional formatting, workbook repair, financial/data-analysis models, and finding difficult Excel practice tests/exercises online.
---

# Excel Professional

## Core Workflow

1. Preserve the original workbook unless the user explicitly wants in-place edits. Create a timestamped copy for risky changes.
2. Inspect the workbook before editing. Run `scripts/xlsx_audit.py <file.xlsx>` for complex files to identify sheets, formulas, tables, pivots, charts, validations, conditional formatting, external connections, macros, and named ranges.
3. Choose the editing path by fidelity:
   - Use Excel desktop automation on Windows when calculations, PivotTables, PivotCharts, Power Query refresh, VBA, slicers, external connections, PDF export, or exact rendering matter. Use `scripts/excel_finalize.py` for refresh/recalculation and PDF export.
   - Use `openpyxl`, `xlsxwriter`, or `pandas` for repeatable data shaping, workbook creation, formatting, formula insertion, and audits.
   - Preserve macros in `.xlsm` files; do not convert to `.xlsx` unless the user confirms macro removal.
4. Treat formulas as user-facing logic. Do not silently replace formulas with values unless requested. Keep structured references, named ranges, number formats, and validation rules stable.
5. Verify with Excel when possible: recalculate, refresh data/Pivots, check formula errors, inspect charts/dashboards, test filters/slicers, and confirm printed/exported layout.

## Common Tasks

- Analysis models: build clear input/calculation/output areas, use tables and named ranges, avoid hidden assumptions, and include checksums/control totals.
- Advanced formulas: prefer modern functions where available (`XLOOKUP`, `FILTER`, `LET`, `LAMBDA`, dynamic arrays), but account for the user’s Excel version.
- Reporting: use PivotTables/PivotCharts, slicers, conditional formatting, and readable dashboards with stable print/export settings.
- Data cleanup: use Power Query or repeatable transformations for messy imports; avoid manual one-off cleanup when the process will repeat.
- VBA/macros: inspect existing code before changes, keep backups, avoid lowering macro security, and document how to run the macro only when needed.

## Practice Mode

When the user asks to improve Excel skills or get hard tests, browse current sources before selecting exercises. Prefer official Microsoft objectives and legitimate public practice files. Avoid exam dumps, answer-key scraping, or copyrighted paid material.

Build practice sets around Microsoft Excel Expert domains:

- Manage workbook options and settings.
- Manage and format data.
- Create advanced formulas and macros.
- Manage advanced charts and tables.

For each practice session, provide: source links, workbook/data files when legally available, task brief, expected deliverables, scoring rubric, time limit, and a debrief checklist. Use `references/practice-sources.md` for curated starting points and refresh them with web search when the user wants new tests.

## Resources

- `scripts/xlsx_audit.py`: quick structural audit of an Excel workbook without requiring Excel to be installed.
- `scripts/excel_finalize.py`: open a workbook in desktop Excel, refresh, recalculate, save a copy, and optionally export PDF.
- `references/excel-workflows.md`: detailed workflow notes for high-fidelity Excel work.
- `references/practice-sources.md`: curated sources and search strategy for difficult Excel exercises.
