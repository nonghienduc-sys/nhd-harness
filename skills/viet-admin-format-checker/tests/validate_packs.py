from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]

required = [
    ROOT / "sources" / "source-registry.yaml",
    ROOT / "registry" / "specialized-router.yaml",
    ROOT / "legal-rules" / "specialized" / "startup" / "bac-ninh" / "2026" / "rules.yaml",
    ROOT / "legal-rules" / "specialized" / "cooperatives" / "registration" / "rules.yaml",
    ROOT / "legal-rules" / "specialized" / "mtqg" / "2026-2030" / "rules.yaml",
    ROOT / "legal-rules" / "specialized" / "agriculture" / "production-support" / "rules.yaml",
    ROOT / "legal-rules" / "specialized" / "investment" / "vietnam" / "rules.yaml",
    ROOT / "validators" / "source-freshness-policy.yaml",
]

loaded = {}
for path in required:
    assert path.exists(), f"missing: {path}"
    loaded[path.name + "::" + str(path.parent)] = yaml.safe_load(path.read_text(encoding="utf-8"))

registry = yaml.safe_load((ROOT / "sources" / "source-registry.yaml").read_text(encoding="utf-8"))
sources = registry["sources"]

assert sources["bacninh_startup_2025_notice"]["status"] == "historical"
assert "guard" in sources["bacninh_startup_2025_notice"]
assert sources["coop_circular_09_2024"]["status"] == "partially_effective"
assert "coop_circular_43_2025" in sources["coop_circular_09_2024"]["amended_by"]
assert sources["mtqg_decree_358_2025"]["status"] == "current"
assert sources["mtqg_circular_23_2026"]["status"] == "current"
assert sources["investment_circular_03_2021"]["status"] == "current_as_verified"

startup = yaml.safe_load((ROOT / "legal-rules" / "specialized" / "startup" / "bac-ninh" / "2026" / "rules.yaml").read_text(encoding="utf-8"))
guards = {item["id"] for item in startup["critical_guards"]}
assert "no_2025_template_inheritance" in guards
assert startup["format_resolution"]["nd30"] == "fallback_only"

coop = yaml.safe_load((ROOT / "legal-rules" / "specialized" / "cooperatives" / "registration" / "rules.yaml").read_text(encoding="utf-8"))
assert coop["form_policy"]["exact_template_required"] is True
assert coop["form_policy"]["two_level_local_government_adjustment"]["required"] is True

mtqg = yaml.safe_load((ROOT / "legal-rules" / "specialized" / "mtqg" / "2026-2030" / "rules.yaml").read_text(encoding="utf-8"))
assert mtqg["reporting_forms_from_tt23_2026"]["commune"]["form"].startswith("Mẫu số 04")
assert mtqg["historical_phase_2021_2025"]["do_not_mix_with_current_pack"] is True

investment = yaml.safe_load((ROOT / "legal-rules" / "specialized" / "investment" / "vietnam" / "rules.yaml").read_text(encoding="utf-8"))
assert investment["format_policy"]["exact_template_required"] is True
assert set(investment["known_forms"]) >= {"A.I.1", "A.I.2", "A.I.3", "A.I.4"}

router = yaml.safe_load((ROOT / "registry" / "specialized-router.yaml").read_text(encoding="utf-8"))
assert len(router["routes"]) >= 5

print(f"PACKS_OK={len(required)} SOURCES={len(sources)} ROUTES={len(router['routes'])}")
