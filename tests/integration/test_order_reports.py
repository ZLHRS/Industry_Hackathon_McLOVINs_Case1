# ruff: noqa: F811 -- imported pytest fixture
"""A real Excel download preserves authorized data and private photo evidence."""

from datetime import UTC, datetime, timedelta
from io import BytesIO
from uuid import UUID, uuid4
from zipfile import ZipFile

import pytest
from PIL import Image
from sqlalchemy import select
from test_order_api import api  # noqa: F401

from naryadai.infrastructure.models import AIReview, Photo

pytestmark = pytest.mark.asyncio


async def test_excel_order_auth_content_and_embedded_photo(api, database):
    client = api["client"]
    headers = api["headers"]["master"]
    body = {
        "area_id": str(api["areas"][0].id),
        "equipment_id": str(api["machines"][0].id),
        "executor_id": str(api["users"]["executor"]),
        "work_type": "unplanned",
        "priority": "normal",
        "deadline": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        "description": "=HYPERLINK(unsafe) inspection",
    }
    result = await client.post(
        "/api/v1/work-orders", headers=headers | {"Idempotency-Key": str(uuid4())}, json=body
    )
    assert result.status_code == 201, result.text
    order_id = result.json()["order_id"]
    # Exercise the actual private upload route (the helper used by browser clients).
    picture = BytesIO()
    Image.new("RGB", (40, 30), "green").save(picture, format="JPEG")
    result = await client.post(
        f"/api/v1/work-orders/{order_id}/photos?kind=before&expected_version=1",
        headers=headers | {"Content-Type": "image/jpeg", "Idempotency-Key": str(uuid4())},
        content=picture.getvalue(),
    )
    assert result.status_code == 201, result.text
    async with database.sessions.begin() as session:
        session.add(
            AIReview(
                work_order_id=UUID(order_id),
                order_version=2,
                score=4,
                master_score=5,
                explanation="Evidence checked",
                model_name="synthetic-test",
                needs_master_review=True,
                report={
                    "timing": {"active_minutes": 12.5, "paused_minutes": 2, "norm_minutes": 15},
                    "checks": [
                        {"title": "Photo evidence", "status": "pass", "detail": "Verified sample"}
                    ],
                    "limitations": ["Synthetic evidence only"],
                },
            )
        )
    response = await client.get(f"/api/v1/work-orders/{order_id}/report.xlsx", headers=headers)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "spreadsheetml.sheet" in response.headers["content-type"]
    with ZipFile(BytesIO(response.content)) as archive:
        assert len([name for name in archive.namelist() if name.startswith("xl/media/")]) == 1
        strings = archive.read("xl/sharedStrings.xml").decode()
        assert "HYPERLINK(unsafe) inspection" in strings
        assert "master" in strings
        assert "Verified sample" in strings
        assert "Synthetic evidence only" in strings
        assert "Норматив, мин" in strings
        sheets = [
            archive.read(n)
            for n in archive.namelist()
            if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")
        ]
        assert all(b"<f>" not in sheet for sheet in sheets)
    for role, code in (
        ("coworker", 404),
        ("foreign", 404),
        ("admin", 403),
        ("executor", 200),
        ("manager", 200),
    ):
        response = await client.get(
            f"/api/v1/work-orders/{order_id}/report.xlsx", headers=api["headers"][role]
        )
        assert response.status_code == code, (role, response.text[:100])
    assert (await client.get(f"/api/v1/work-orders/{order_id}/report.xlsx")).status_code == 401
    # Metadata corruption must fail the complete download, never silently omit the photograph.
    async with database.sessions.begin() as session:
        photo = await session.scalar(select(Photo).where(Photo.work_order_id == UUID(order_id)))
        photo.sha256 = "0" * 64
    corrupt = await client.get(f"/api/v1/work-orders/{order_id}/report.xlsx", headers=headers)
    assert corrupt.status_code == 409
    assert corrupt.json()["detail"] == "report_photo_unavailable"


async def test_evidence_http_validation_and_owner(api):
    client = api["client"]
    master = api["headers"]["master"]
    body = {
        "area_id": str(api["areas"][0].id),
        "equipment_id": str(api["machines"][0].id),
        "executor_id": str(api["users"]["executor"]),
        "work_type": "planned",
        "priority": "planned",
        "deadline": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        "description": "Inspection",
    }
    created = await client.post(
        "/api/v1/work-orders", headers=master | {"Idempotency-Key": str(uuid4())}, json=body
    )
    order_id = created.json()["order_id"]
    endpoint = f"/api/v1/work-orders/{order_id}/downtime"
    valid = {
        "expected_version": 1,
        "started_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
        "reason": "Confirmed stop",
    }
    response = await client.post(
        endpoint, headers=master | {"Idempotency-Key": str(uuid4())}, json=valid
    )
    assert response.status_code == 200 and response.json()["status"] == "issued"
    response = await client.post(
        endpoint,
        headers=api["headers"]["colleague"] | {"Idempotency-Key": str(uuid4())},
        json=valid | {"expected_version": 2},
    )
    assert response.status_code == 403
    response = await client.post(
        endpoint,
        headers=master | {"Idempotency-Key": str(uuid4())},
        json=valid | {"started_at": "2026-01-01T00:00:00"},
    )
    assert response.status_code == 422
