# ruff: noqa: F811 -- imported pytest fixture
from datetime import UTC, datetime
from io import BytesIO
from zipfile import ZipFile

import pytest
from test_order_api import api  # noqa: F401

pytestmark = pytest.mark.asyncio


async def test_empty_report_export_summary_and_access(api):
    client = api["client"]
    headers = api["headers"]["manager"]
    query = {"period": "day", "date": datetime.now(UTC).date().isoformat()}
    report = await client.get("/api/v1/analytics/report", headers=headers, params=query)
    assert report.status_code == 200, report.text
    assert report.json()["orders"]["issued"] == 0
    download = await client.get("/api/v1/analytics/export", headers=headers, params=query)
    assert download.status_code == 200, download.text[:200]
    assert download.headers["cache-control"] == "no-store"
    with ZipFile(BytesIO(download.content)) as archive:
        assert "xl/workbook.xml" in archive.namelist()
        assert "Сводка" in archive.read("xl/workbook.xml").decode()
    narrative = await client.post("/api/v1/analytics/summary", headers=headers, params=query)
    assert narrative.status_code == 200, narrative.text
    assert narrative.json()["source"] == "rules"
    assert narrative.json()["model"] is None
    assert (
        await client.post("/api/v1/analytics/summary", headers=headers, params=query)
    ).status_code == 429
    for endpoint in ("report", "export", "options"):
        response = await client.get(
            f"/api/v1/analytics/{endpoint}",
            headers=api["headers"]["admin"],
            params=query if endpoint != "options" else {},
        )
        assert response.status_code == 403
        assert (await client.get(f"/api/v1/analytics/{endpoint}", params=query)).status_code == 401


async def test_export_scope_and_executor_no_peers(api):
    client = api["client"]
    params = {
        "period": "day",
        "date": datetime.now(UTC).date().isoformat(),
        "area_id": str(api["areas"][1].id),
    }
    for endpoint in ("report", "export"):
        response = await client.get(
            f"/api/v1/analytics/{endpoint}", headers=api["headers"]["master"], params=params
        )
        assert response.status_code == 404
    response = await client.get("/api/v1/analytics/options", headers=api["headers"]["executor"])
    assert response.status_code == 200
    options = response.json()
    assert all(row["id"] == str(api["users"]["executor"]) for row in options["executors"])
    assert options["brigades"] == []
    assert all(row["id"] != str(api["users"]["foreign"]) for row in options["executors"])
