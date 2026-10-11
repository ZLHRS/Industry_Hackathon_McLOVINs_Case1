"""Parser limits for the add-only XLSX catalog import."""

from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
import xlsxwriter

from naryadai.application.catalog_import import parse_workbook
from naryadai.application.common import OperationError


def _book(*, formula: bool = False, numeric_inventory: bool = False) -> bytes:
    stream = BytesIO()
    book = xlsxwriter.Workbook(stream, {"in_memory": True})
    equipment = book.add_worksheet("Equipment")
    materials = book.add_worksheet("Materials")
    equipment.write_row(
        0,
        0,
        ["area_code", "inventory_number", "name", "equipment_type", "criticality"],
    )
    equipment.write_row(1, 0, ["A-1", 123 if numeric_inventory else "00123", "Pump", "pump", 3])
    if formula:
        materials.write_formula(1, 0, '="MAT"')
    materials.write_row(0, 0, ["code", "name", "unit"])
    if not formula:
        materials.write_row(1, 0, ["MAT-1", "Seal", "pcs"])
    book.close()
    return stream.getvalue()


def _sparse_reference(content: bytes) -> bytes:
    source = BytesIO(content)
    target = BytesIO()
    with ZipFile(source) as archive, ZipFile(target, "w", ZIP_DEFLATED) as output:
        for item in archive.infolist():
            payload = archive.read(item)
            if item.filename == "xl/worksheets/sheet1.xml":
                payload = payload.replace(b'r="A1"', b'r="XFD1"', 1)
            output.writestr(item, payload)
    return target.getvalue()


def test_parse_catalog_import_preserves_text_identifiers() -> None:
    parsed = parse_workbook(_book())
    assert parsed.equipment[0].inventory_number == "00123"
    assert parsed.materials[0].code == "MAT-1"


def test_parse_catalog_import_rejects_formula_and_numeric_identifier() -> None:
    with pytest.raises(OperationError, match="unsafe_import_workbook"):
        parse_workbook(_book(formula=True))
    parsed = parse_workbook(_book(numeric_inventory=True))
    assert parsed.equipment_rows[0].status == "error"


def test_parse_catalog_import_rejects_sparse_out_of_bounds_cell_reference() -> None:
    with pytest.raises(OperationError, match="import_sheet_limit_exceeded"):
        parse_workbook(_sparse_reference(_book()))
