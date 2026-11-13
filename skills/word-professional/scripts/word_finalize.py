#!/usr/bin/env python3
import argparse
import shutil
import sys
from pathlib import Path

import win32com.client as win32

WD_EXPORT_FORMAT_PDF = 17
WD_ALERTS_NONE = 0


def update_story_fields(doc):
    for story in doc.StoryRanges:
        current = story
        while current is not None:
            try:
                current.Fields.Update()
            except Exception:
                pass
            try:
                current = current.NextStoryRange
            except Exception:
                current = None


def update_section_fields(doc):
    for section in doc.Sections:
        for header in section.Headers:
            try:
                header.Range.Fields.Update()
            except Exception:
                pass
        for footer in section.Footers:
            try:
                footer.Range.Fields.Update()
            except Exception:
                pass


def update_document_fields(doc):
    try:
        doc.Fields.Update()
    except Exception:
        pass
    update_story_fields(doc)
    update_section_fields(doc)
    for collection_name in ("TablesOfContents", "TablesOfFigures", "TablesOfAuthorities"):
        try:
            collection = getattr(doc, collection_name)
            for item in collection:
                try:
                    item.Update()
                except Exception:
                    pass
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(
        description="Finalize a Word document with desktop Word: update fields and optionally export PDF."
    )
    parser.add_argument("file", help="Source .docx/.docm/.dotx file")
    parser.add_argument("--output", help="Output Word file. Defaults to <name>.finalized<ext>.")
    parser.add_argument("--in-place", action="store_true", help="Modify the source file directly.")
    parser.add_argument("--pdf", nargs="?", const=True, help="Export PDF. Optionally pass output PDF path.")
    parser.add_argument("--visible", action="store_true", help="Show Word while processing.")
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

    word = win32.DispatchEx("Word.Application")
    word.Visible = bool(args.visible)
    word.DisplayAlerts = WD_ALERTS_NONE
    doc = None
    try:
        doc = word.Documents.Open(str(work), ReadOnly=False, AddToRecentFiles=False)
        update_document_fields(doc)
        doc.Save()
        if pdf_path:
            doc.ExportAsFixedFormat(str(pdf_path), WD_EXPORT_FORMAT_PDF)
        print(f"word_file={work}")
        if pdf_path:
            print(f"pdf_file={pdf_path}")
    finally:
        if doc is not None:
            doc.Close(SaveChanges=True)
        word.Quit()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
