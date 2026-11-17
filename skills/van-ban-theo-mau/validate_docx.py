"""Run the unmodified Anthropic DOCX validator under Python -I.

Python isolated mode omits the script directory from sys.path, so upstream
"from helpers import ..." needs an explicit trusted local import root.
"""
from pathlib import Path
import runpy
import sys

UPSTREAM = Path(__file__).resolve().parent.parent / "anthropic-docx" / "scripts" / "office" / "validate.py"
if not UPSTREAM.is_file():
    raise SystemExit("Anthropic DOCX validator not found")
sys.path.insert(0, str(UPSTREAM.parent))
sys.argv = [str(UPSTREAM), *sys.argv[1:]]
runpy.run_path(str(UPSTREAM), run_name="__main__")
