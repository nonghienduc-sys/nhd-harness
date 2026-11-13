#!/usr/bin/env python3
import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def read_xml(zf, name):
    try:
        return ET.fromstring(zf.read(name))
    except KeyError:
        return None
    except ET.ParseError as exc:
        return {"parse_error": str(exc)}


def attr(el, name):
    return el.get(f"{{{NS['main']}}}{name}") or el.get(name)


def count(root, path):
    if root is None or isinstance(root, dict):
        return 0
    return len(root.findall(path, NS))


def rel_map(zf, rels_path):
    root = read_xml(zf, rels_path)
    result = {}
    if root is None or isinstance(root, dict):
        return result
    for rel in root.findall(".//rel:Relationship", NS):
        result[rel.get("Id")] = rel.get("Target")
    return result


def normalize_target(base, target):
    if not target:
        return None
    if target.startswith("/"):
        return target.lstrip("/")
    base_parts = base.split("/")[:-1]
    parts = []
    for part in base_parts + target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
        else:
            parts.append(part)
    return "/".join(parts)


def dimension_to_size(ref):
    if not ref:
        return None
    last = ref.split(":")[-1]
    m = re.match(r"([A-Z]+)(\d+)$", last)
    if not m:
        return None
    col_letters, row = m.groups()
    col = 0
    for ch in col_letters:
        col = col * 26 + ord(ch) - 64
    return {"rows": int(row), "columns": col}


def audit(path):
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(path)

    result = {
        "file": str(p),
        "size_bytes": p.stat().st_size,
        "extension": p.suffix.lower(),
        "is_macro_enabled": p.suffix.lower() in (".xlsm", ".xltm"),
    }

    with zipfile.ZipFile(p) as zf:
        names = set(zf.namelist())
        workbook = read_xml(zf, "xl/workbook.xml")
        workbook_rels = rel_map(zf, "xl/_rels/workbook.xml.rels")

        sheets = []
        if workbook is not None and not isinstance(workbook, dict):
            for sheet in workbook.findall(".//main:sheet", NS):
                name = attr(sheet, "name")
                rid = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                target = normalize_target("xl/workbook.xml", workbook_rels.get(rid))
                sheet_info = {"name": name, "path": target}
                root = read_xml(zf, target) if target else None
                if root is not None and not isinstance(root, dict):
                    dim = root.find("main:dimension", NS)
                    sheet_info.update({
                        "dimension": attr(dim, "ref") if dim is not None else None,
                        "estimated_size": dimension_to_size(attr(dim, "ref") if dim is not None else None),
                        "rows_with_data": count(root, ".//main:sheetData/main:row"),
                        "cells": count(root, ".//main:c"),
                        "formula_cells": count(root, ".//main:c/main:f"),
                        "merged_ranges": count(root, ".//main:mergeCells/main:mergeCell"),
                        "conditional_formatting_blocks": count(root, ".//main:conditionalFormatting"),
                        "data_validation_blocks": count(root, ".//main:dataValidations/main:dataValidation"),
                        "tables_declared": count(root, ".//main:tableParts/main:tablePart"),
                    })
                sheets.append(sheet_info)

        styles = read_xml(zf, "xl/styles.xml")
        workbook_summary = {
            "sheets": len(sheets),
            "defined_names": count(workbook, ".//main:definedName"),
            "tables": len([n for n in names if n.startswith("xl/tables/") and n.endswith(".xml")]),
            "charts": len([n for n in names if n.startswith("xl/charts/") and n.endswith(".xml")]),
            "pivot_cache_definitions": len([n for n in names if n.startswith("xl/pivotCache/") and n.endswith(".xml")]),
            "pivot_tables": len([n for n in names if n.startswith("xl/pivotTables/") and n.endswith(".xml")]),
            "external_links": len([n for n in names if n.startswith("xl/externalLinks/") and n.endswith(".xml")]),
            "query_tables": len([n for n in names if n.startswith("xl/queryTables/") and n.endswith(".xml")]),
            "connections": "xl/connections.xml" in names,
            "data_model": any(n.startswith("xl/model/") for n in names),
            "vba_project": "xl/vbaProject.bin" in names,
            "custom_xml_parts": len([n for n in names if n.startswith("customXml/") and n.endswith(".xml")]),
            "shared_strings": count(read_xml(zf, "xl/sharedStrings.xml"), ".//main:si"),
            "cell_formats": count(styles, ".//main:cellXfs/main:xf"),
            "custom_number_formats": count(styles, ".//main:numFmts/main:numFmt"),
        }

        result["workbook"] = workbook_summary
        result["sheets"] = sheets

    return result


def main():
    parser = argparse.ArgumentParser(description="Audit an XLSX/XLSM workbook structure.")
    parser.add_argument("file")
    args = parser.parse_args()
    print(json.dumps(audit(args.file), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
