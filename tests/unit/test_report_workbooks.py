"""Exports must remain literal, readable, and numerically faithful."""

from io import BytesIO
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import pytest

from naryadai.application.common import OperationError
from naryadai.reporting.workbooks import ReportWorkbook

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def test_spreadsheet_strings_do_not_execute_formulas_or_links():
    book = ReportWorkbook("Report")
    book.table(
        "Data",
        ["Text", "Number"],
        [
            ['=HYPERLINK("https://invalid.example","click")', 42.5],
            ["+SUM(A1:A2)", None],
            ["@external", True],
            ["https://invalid.example", -2],
        ],
    )
    with ZipFile(BytesIO(book.finish())) as archive:
        xml = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        assert xml.findall(".//m:f", NS) == []
        assert xml.findall(".//m:hyperlink", NS) == []
        # XlsxWriter may omit the numeric type attribute (OOXML defaults to n).
        assert xml.find(".//m:c[@r='B2']/m:v", NS).text == "42.5"
        strings = archive.read("xl/sharedStrings.xml").decode()
        assert "HYPERLINK" in strings and "https://invalid.example" in strings
        assert xml.find("m:sheetViews/m:sheetView/m:pane", NS) is not None
        assert xml.find("m:autoFilter", NS) is not None
        assert not any("externalLink" in name for name in archive.namelist())


def test_oversize_cell_is_rejected_instead_of_silent_truncation():
    book = ReportWorkbook("Report")
    with pytest.raises(OperationError, match="report_cell_too_long"):
        book.table("Data", ["Text"], [["x" * 32768]])
    book.finish()
