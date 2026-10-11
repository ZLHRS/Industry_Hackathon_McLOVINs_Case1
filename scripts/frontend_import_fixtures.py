"""Generate temporary XLSX files for catalog-import browser tests (no database writes)."""

# ruff: noqa: RUF001

import json
from pathlib import Path
from uuid import uuid4

from xlsxwriter import Workbook

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tmp" / "excel-import-fixtures"


def workbook(name: str, equipment: list[list[object]], materials: list[list[object]]) -> None:
    with Workbook(OUTPUT / name, {"strings_to_formulas": False, "strings_to_urls": False}) as book:
        for title, headers, rows in (
            (
                "Equipment",
                ["area_code", "inventory_number", "name", "equipment_type", "criticality"],
                equipment,
            ),
            ("Materials", ["code", "name", "unit"], materials),
        ):
            sheet = book.add_worksheet(title)
            sheet.write_row(0, 0, headers)
            for index, row in enumerate(rows, 1):
                sheet.write_row(index, 0, row)


def main() -> None:
    state_path = ROOT / "tmp" / "e2e-server.json"
    if not state_path.is_file():
        raise SystemExit("Start scripts/frontend_test_server.py first")
    area_code = json.loads(state_path.read_text(encoding="utf-8"))["area_code"]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    tag = uuid4().hex[:8].upper()
    manifest: dict[str, object] = {}
    for width in (1440, 390):
        equipment_key = f"XL-E-{tag}-{width}"
        material_key = f"XL-M-{tag}-{width}"
        workbook(
            f"valid-{width}.xlsx",
            [[area_code, equipment_key, "Насос оборотной воды", "pump", 3]],
            [[material_key, "Уплотнение вала", "шт"]],
        )
        manifest[str(width)] = {"equipment_key": equipment_key, "material_key": material_key}
    invalid_key = f"XL-INVALID-{tag}"
    workbook(
        "invalid.xlsx",
        [["UNKNOWN-AREA", invalid_key, "Насос", "pump", 9]],
        [[invalid_key, "Материал из ошибочного файла", "шт"]],
    )
    workbook("pages.xlsx", [], [[f"XL-P-{tag}-{i:02}", f"Втулка {i + 1}", "шт"] for i in range(15)])
    workbook("replacement.xlsx", [], [[f"XL-NEW-{tag}", "Новое уплотнение", "шт"]])
    workbook("stale.xlsx", [], [[f"XL-STALE-{tag}", "Кольцо уплотнительное", "шт"]])
    manifest["invalid_key"] = invalid_key
    manifest["stale_key"] = f"XL-STALE-{tag}"
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    print("XLSX browser fixtures ready in tmp/excel-import-fixtures")


if __name__ == "__main__":
    main()
