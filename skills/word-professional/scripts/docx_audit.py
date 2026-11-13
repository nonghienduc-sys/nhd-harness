#!/usr/bin/env python3
import argparse
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def read_xml(zf, name):
    try:
        return ET.fromstring(zf.read(name))
    except KeyError:
        return None
    except ET.ParseError as exc:
        return {"parse_error": str(exc)}


def count(root, path):
    if root is None or isinstance(root, dict):
        return 0
    return len(root.findall(path, NS))


def attr(el, namespace, name):
    return el.get(f"{{{NS[namespace]}}}{name}")


def text_of(el):
    return "".join(t.text or "" for t in el.findall(".//w:t", NS)).strip()


def audit(path):
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(path)

    result = {
        "file": str(p),
        "size_bytes": p.stat().st_size,
        "extension": p.suffix.lower(),
        "is_macro_enabled": p.suffix.lower() == ".docm",
    }

    with zipfile.ZipFile(p) as zf:
        names = set(zf.namelist())
        doc = read_xml(zf, "word/document.xml")
        styles = read_xml(zf, "word/styles.xml")
        settings = read_xml(zf, "word/settings.xml")
        rels = read_xml(zf, "word/_rels/document.xml.rels")
        comments = read_xml(zf, "word/comments.xml")

        result["parts"] = {
            "headers": len([n for n in names if n.startswith("word/header") and n.endswith(".xml")]),
            "footers": len([n for n in names if n.startswith("word/footer") and n.endswith(".xml")]),
            "footnotes": "word/footnotes.xml" in names,
            "endnotes": "word/endnotes.xml" in names,
            "comments": "word/comments.xml" in names,
            "vba_project": "word/vbaProject.bin" in names,
        }

        result["document"] = {
            "paragraphs": count(doc, ".//w:p"),
            "tables": count(doc, ".//w:tbl"),
            "sections": count(doc, ".//w:sectPr"),
            "images": 0,
            "hyperlinks": count(doc, ".//w:hyperlink"),
            "content_controls": count(doc, ".//w:sdt"),
            "bookmarks": count(doc, ".//w:bookmarkStart"),
            "comments": count(comments, ".//w:comment"),
            "tracked_insertions": count(doc, ".//w:ins"),
            "tracked_deletions": count(doc, ".//w:del"),
            "tracked_moves": count(doc, ".//w:moveFrom") + count(doc, ".//w:moveTo"),
        }

        field_text = []
        if doc is not None and not isinstance(doc, dict):
            for node in doc.findall(".//w:instrText", NS):
                if node.text:
                    field_text.append(node.text.strip())
            for node in doc.findall(".//w:fldSimple", NS):
                instr = attr(node, "w", "instr")
                if instr:
                    field_text.append(instr.strip())
        joined_fields = "\n".join(field_text).upper()
        result["fields"] = {
            "count": len(field_text),
            "has_toc": "TOC" in joined_fields,
            "has_ref_or_pageref": " REF " in f" {joined_fields} " or "PAGEREF" in joined_fields,
            "has_merge_fields": "MERGEFIELD" in joined_fields,
        }

        if rels is not None and not isinstance(rels, dict):
            image_targets = []
            for rel in rels.findall(".//rel:Relationship", NS):
                target = rel.get("Target") or ""
                rel_type = rel.get("Type") or ""
                if "image" in rel_type or target.startswith("media/"):
                    image_targets.append(target)
            result["document"]["images"] = len(image_targets)

        heading_styles = []
        custom_styles = []
        if styles is not None and not isinstance(styles, dict):
            for style in styles.findall(".//w:style", NS):
                style_id = attr(style, "w", "styleId") or ""
                name_node = style.find("w:name", NS)
                name = attr(name_node, "w", "val") if name_node is not None else style_id
                custom = attr(style, "w", "customStyle") == "1"
                if style_id.lower().startswith("heading") or (name or "").lower().startswith("heading"):
                    heading_styles.append({"id": style_id, "name": name})
                if custom:
                    custom_styles.append({"id": style_id, "name": name})
        result["styles"] = {
            "heading_styles": heading_styles[:30],
            "custom_styles_count": len(custom_styles),
            "custom_styles_sample": custom_styles[:30],
        }

        protection = None
        if settings is not None and not isinstance(settings, dict):
            node = settings.find(".//w:documentProtection", NS)
            if node is not None:
                protection = {
                    "edit": attr(node, "w", "edit"),
                    "enforcement": attr(node, "w", "enforcement"),
                }
        result["protection"] = protection

    return result


def main():
    parser = argparse.ArgumentParser(description="Audit a DOCX/DOTX/DOCM file structure.")
    parser.add_argument("file")
    args = parser.parse_args()
    print(json.dumps(audit(args.file), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
