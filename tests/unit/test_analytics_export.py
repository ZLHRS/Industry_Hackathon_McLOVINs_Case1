"""Report workbooks preserve computed metrics, units, scope and evidence."""

from datetime import UTC, datetime, timedelta
from io import BytesIO
from uuid import uuid4
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from naryadai.analytics.contracts import AnalyticsReport
from naryadai.reporting.analytics_report import export_analytics

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def report_fixture():
    now = datetime.now(UTC)
    return AnalyticsReport.model_validate(
        {
            "period": {
                "kind": "day",
                "timezone": "Asia/Qostanay",
                "from_": now - timedelta(days=1),
                "to": now,
                "label": "Control day",
            },
            "filters": {},
            "scope": {"role": "master", "area_ids": []},
            "orders": {
                "issued": 10,
                "completed": 8,
                "closed": 7,
                "overdue": 2,
                "rejected": 1,
                "backlog": 3,
            },
            "durations": {"response_seconds": 90, "work_seconds": 3600, "pause_seconds": None},
            "activity": {"active_order_count": 5, "active_seconds": 18000},
            "downtime": {
                "known_seconds": 1200,
                "unknown_order_count": 2,
                "by_equipment": [
                    {
                        "equipment_id": str(uuid4()),
                        "equipment_name": "Pump",
                        "known_seconds": 1200,
                        "unknown_order_count": 2,
                    }
                ],
            },
            "ratings": {
                "employees": [
                    {
                        "subject_id": str(uuid4()),
                        "subject_name": "=unsafe",
                        "score": 75,
                        "sample_size": 7,
                        "components": {
                            "quality": {
                                "value": 0.8,
                                "numerator": 4,
                                "denominator": 5,
                                "detail": "4 of 5",
                            }
                        },
                        "unavailable_components": ["refusal"],
                    }
                ],
                "brigades": [],
                "limitations": ["Small sample"],
            },
            "materials": {
                "usage": [
                    {
                        "material_id": str(uuid4()),
                        "material_name": "Seal",
                        "unit": "kg",
                        "quantity": 0.001,
                        "order_count": 1,
                    }
                ]
            },
            "leaders": {
                "machines": [
                    {"id": str(uuid4()), "name": "Pump", "order_count": 3, "overdue_count": 1}
                ]
            },
            "anomalies": [
                {
                    "family": "recurring_fault",
                    "severity": "medium",
                    "title": "Repeated fault",
                    "formula": "count>=3",
                    "evidence": {"count": 3, "order_ids": [str(uuid4())]},
                }
            ],
            "meta": {
                "as_of": now,
                "row_count": 10,
                "synthetic_count": 10,
                "formula_descriptions": {"quality": "master preferred"},
                "warnings": ["No real downtime for 2 orders"],
            },
        }
    )


def test_analytics_workbook_reconciles_source_values_and_keeps_units():
    report = report_fixture()
    with ZipFile(BytesIO(export_analytics(report))) as archive:
        xml = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        assert xml.find(".//m:c[@r='B7']/m:v", NS).text == str(report.orders.issued)
        strings = archive.read("xl/sharedStrings.xml").decode()
        assert "Seal" in strings and "kg" in strings and "=unsafe" in strings
        assert "Small sample" in strings and "master preferred" in strings
        assert "Нет данных" in strings
        assert any(n.startswith("xl/charts/chart") for n in archive.namelist())
        worksheets = [
            archive.read(n)
            for n in archive.namelist()
            if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")
        ]
        assert all(b"<f>" not in xml for xml in worksheets)
        assert any(b"<v>0.001</v>" in xml for xml in worksheets)


def test_empty_report_exports_without_a_fake_rating():
    report = report_fixture()
    report.ratings.employees = []
    report.materials.usage = []
    report.anomalies = []
    with ZipFile(BytesIO(export_analytics(report))) as archive:
        assert not any(n.startswith("xl/charts/chart") for n in archive.namelist())
