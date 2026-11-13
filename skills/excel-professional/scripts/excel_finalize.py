#!/usr/bin/env python3
import argparse
import shutil
import sys
from pathlib import Path

import win32com.client as win32

XL_TYPE_PDF = 0
MSO_AUTOMATION_SECURITY_FORCE_DISABLE = 3


def main():
    parser = argparse.ArgumentParser(
        description="Finalize an Excel workbook with desktop Excel: refresh, recalculate, and optionally export PDF."
    )
    parser.add_argument("file", help="Source .xlsx/.xlsm/.xlsb workbook")
    parser.add_argument("--output", help="Output workbook. Defaults to <name>.finalized<ext>.")
    parser.add_argument("--in-place", action="store_true", help="Modify the source workbook directly.")
    parser.add_argument("--refresh", action="store_true", help="Refresh workbook connections and PivotTables.")
    parser.add_argument("--pdf", nargs="?", const=True, help="Export PDF. Optionally pass output PDF path.")
    parser.add_argument("--allow-macros", action="store_true", help="Allow auto macros while opening. Default disables them.")
    parser.add_argument("--visible", action="store_true", help="Show Excel while processing.")
    args = parser.parse_args()

    src = Path(args.file).resolve()
    if not src.exists():
        raise FileNotFoundError(src)

    if args.in_place:
        work = src
    else:
        work = Path(args.output).resolve() if args.output else src.with_name(f"{src.stem}.finalized{src.suffix}")
        if work != src:
            shutil.copy2(src, work)

    pdf_path = None
    if args.pdf:
        if isinstance(args.pdf, str):
            pdf_path = Path(args.pdf).resolve()
        else:
            pdf_path = work.with_suffix(".pdf")

    excel = win32.DispatchEx("Excel.Application")
    excel.Visible = bool(args.visible)
    excel.DisplayAlerts = False
    excel.AskToUpdateLinks = False
    if not args.allow_macros:
        try:
            excel.AutomationSecurity = MSO_AUTOMATION_SECURITY_FORCE_DISABLE
        except Exception:
            pass

    wb = None
    try:
        wb = excel.Workbooks.Open(str(work), UpdateLinks=0, ReadOnly=False)
        if args.refresh:
            wb.RefreshAll()
            try:
                excel.CalculateUntilAsyncQueriesDone()
            except Exception:
                pass
        try:
            excel.CalculateFullRebuild()
        except Exception:
            excel.CalculateFull()
        wb.Save()
        if pdf_path:
            wb.ExportAsFixedFormat(XL_TYPE_PDF, str(pdf_path))
        print(f"workbook={work}")
        if pdf_path:
            print(f"pdf_file={pdf_path}")
    finally:
        if wb is not None:
            wb.Close(SaveChanges=True)
        excel.Quit()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
