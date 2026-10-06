from datetime import UTC, datetime, timedelta
from io import BytesIO
from uuid import uuid4
from zipfile import ZipFile

import pytest
from seeds.industrial.generator import generate_dataset
from seeds.industrial.storage import maintain

from naryadai.analytics.contracts import AnalyticsQuery
from naryadai.analytics.service import build_report
from naryadai.auth.dependencies import Principal
from naryadai.reporting.analytics_report import export_analytics


@pytest.mark.asyncio
async def test_seed_populates_real_analytics_contract_and_excel(database):
    anchor = datetime(2026, 10, 6, 12, tzinfo=UTC)
    rows = generate_dataset(anchor=anchor)
    await maintain(
        database,
        action="apply",
        environment="test",
        dataset=rows,
        anchor=anchor.date(),
        secret="local-report-test-password",
    )
    master = next(person for person in rows["employees"] if person["role"] == "master")
    principal = Principal(
        master["id"],
        uuid4(),
        master["login"],
        master["display_name"],
        "master",
        tuple(row["id"] for row in rows["areas"]),
    )
    query = AnalyticsQuery.model_validate(
        {
            "period": "custom",
            "from": anchor - timedelta(days=130),
            "to": anchor + timedelta(days=1),
        }
    )
    report = await build_report(database, principal, query, now=anchor)
    assert report.orders.issued == 600
    assert report.orders.closed == sum(row["status"] == "closed" for row in rows["work_orders"])
    assert report.downtime.known_seconds > 0
    assert report.materials.usage
    assert report.ratings.employees
    assert any(row.components["quality"].value is not None for row in report.ratings.employees)
    assert "демо" not in report.model_dump_json().lower()
    assert "demo" not in report.model_dump_json().lower()
    with ZipFile(BytesIO(export_analytics(report))) as workbook:
        assert workbook.testzip() is None
        assert "xl/workbook.xml" in workbook.namelist()
