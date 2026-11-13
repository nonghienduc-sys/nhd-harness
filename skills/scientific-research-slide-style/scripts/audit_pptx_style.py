#!/usr/bin/env python3
"""Audit PPTX files against the scientific research template style profile."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from statistics import median
from typing import Iterable
from zipfile import ZipFile
import xml.etree.ElementTree as ET

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
EMU_PER_INCH = 914400


def tag(ns: str, name: str) -> str:
    return f"{{{ns}}}{name}"


def read_xml(zip_file: ZipFile, name: str) -> ET.Element | None:
    try:
        return ET.fromstring(zip_file.read(name))
    except KeyError:
        return None


def slide_number(name: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", name)
    return int(match.group(1)) if match else 0


def collect_colors(root: ET.Element) -> Counter[str]:
    colors: Counter[str] = Counter()
    for node in root.iter(tag(NS_A, "srgbClr")):
        value = node.attrib.get("val")
        if value:
            colors[value.upper()] += 1
    for node in root.iter(tag(NS_A, "schemeClr")):
        value = node.attrib.get("val")
        if value:
            colors[f"scheme:{value}"] += 1
    return colors


def collect_fonts(root: ET.Element) -> Counter[str]:
    fonts: Counter[str] = Counter()
    for node in root.iter(tag(NS_A, "latin")):
        value = node.attrib.get("typeface")
        if value:
            fonts[value] += 1
    return fonts


def collect_sizes(root: ET.Element) -> Counter[float]:
    sizes: Counter[float] = Counter()
    for node in root.iter():
        value = node.attrib.get("sz")
        if not value:
            continue
        try:
            sizes[round(int(value) / 100, 1)] += 1
        except ValueError:
            pass
    return sizes


def collect_geometries(root: ET.Element) -> Counter[str]:
    geometries: Counter[str] = Counter()
    for node in root.iter(tag(NS_A, "prstGeom")):
        value = node.attrib.get("prst")
        if value:
            geometries[value] += 1
    return geometries


def findall_names(zip_file: ZipFile, pattern: str) -> list[str]:
    regex = re.compile(pattern)
    return sorted((name for name in zip_file.namelist() if regex.match(name)), key=slide_number)


def summarize_pptx(path: Path) -> dict:
    with ZipFile(path) as zip_file:
        presentation = read_xml(zip_file, "ppt/presentation.xml")
        if presentation is None:
            raise ValueError(f"{path} does not look like a PPTX file")

        size_node = presentation.find(f".//{tag(NS_P, 'sldSz')}")
        if size_node is not None:
            width = round(int(size_node.attrib["cx"]) / EMU_PER_INCH, 2)
            height = round(int(size_node.attrib["cy"]) / EMU_PER_INCH, 2)
        else:
            width = height = 0

        slides = findall_names(zip_file, r"ppt/slides/slide\d+\.xml$")
        colors: Counter[str] = Counter()
        fonts: Counter[str] = Counter()
        sizes: Counter[float] = Counter()
        geometries: Counter[str] = Counter()
        picture_counts: list[int] = []
        shape_counts: list[int] = []

        for slide in slides:
            root = read_xml(zip_file, slide)
            if root is None:
                continue
            colors.update(collect_colors(root))
            fonts.update(collect_fonts(root))
            sizes.update(collect_sizes(root))
            geometries.update(collect_geometries(root))
            picture_counts.append(sum(1 for _ in root.iter(tag(NS_P, "pic"))))
            shape_counts.append(sum(1 for _ in root.iter(tag(NS_P, "sp"))))

        return {
            "file": str(path),
            "slides": len(slides),
            "size_in": [width, height],
            "top_colors": colors.most_common(12),
            "top_fonts": fonts.most_common(12),
            "top_font_sizes": sizes.most_common(12),
            "top_geometries": geometries.most_common(12),
            "median_pictures": median(picture_counts) if picture_counts else 0,
            "median_shapes": median(shape_counts) if shape_counts else 0,
        }


def audit(summary: dict) -> list[str]:
    warnings: list[str] = []
    width, height = summary["size_in"]
    if abs(width - 20.0) > 0.05 or abs(height - 11.25) > 0.05:
        warnings.append("Canvas is not the reference 20 x 11.25 inch widescreen size.")

    if summary["slides"] < 8:
        warnings.append("Deck is very short; reference decks usually have 20 to 36 slides.")

    size_values = [float(size) for size, _count in summary["top_font_sizes"]]
    if size_values and 16.0 not in size_values[:5]:
        warnings.append("16 pt body text is not prominent in the top font sizes.")
    if size_values and max(size_values) < 50:
        warnings.append("No large 50+ pt title size detected.")

    geometries = {name for name, _count in summary["top_geometries"]}
    if "ellipse" not in geometries:
        warnings.append("Ellipse/circle geometry is missing; it is a major reference motif.")
    if not ({"rect", "roundRect"} & geometries):
        warnings.append("Rectangle or rounded rectangle geometry is missing.")

    if summary["median_shapes"] < 12:
        warnings.append("Median shape count is low; reference slides are shape-heavy.")

    if len(summary["top_colors"]) < 5:
        warnings.append("Palette appears too thin; reference decks use neutrals plus several accents.")

    return warnings


def iter_inputs(paths: Iterable[str]) -> list[Path]:
    results: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            results.extend(sorted(path.glob("*.pptx")))
        else:
            results.append(path)
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", help="PPTX file(s) or directories to audit")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    args = parser.parse_args()

    summaries = []
    for path in iter_inputs(args.inputs):
        summary = summarize_pptx(path)
        summary["warnings"] = audit(summary)
        summaries.append(summary)

    if args.json:
        print(json.dumps(summaries, indent=2))
        return 0

    for summary in summaries:
        print(Path(summary["file"]).name)
        print(f"  slides: {summary['slides']}  size: {summary['size_in'][0]} x {summary['size_in'][1]} in")
        print(f"  median pictures/shapes: {summary['median_pictures']} / {summary['median_shapes']}")
        print(f"  fonts: {summary['top_fonts'][:5]}")
        print(f"  sizes: {summary['top_font_sizes'][:8]}")
        print(f"  colors: {summary['top_colors'][:8]}")
        print(f"  geometries: {summary['top_geometries'][:8]}")
        if summary["warnings"]:
            for warning in summary["warnings"]:
                print(f"  WARN: {warning}")
        else:
            print("  OK: matches the reference structural profile")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
