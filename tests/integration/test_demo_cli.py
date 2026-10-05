"""Exercise the demo command against PostgreSQL and consume its data through HTTP."""

from datetime import date

import pytest
from httpx2 import ASGITransport, AsyncClient

from naryadai.app import create_app
from naryadai.config import Settings
from naryadai.demo.__main__ import _run, main


@pytest.mark.asyncio
async def test_seed_cli_output_and_api_contract(database, monkeypatch, capsys):
    url = database.engine.url.render_as_string(hide_password=False)
    monkeypatch.setenv("NARYADAI_DATABASE_URL", url)
    secret = "local-cli-test-secret"
    assert await _run(date(2026, 10, 5), 42, secret) == 0
    assert await _run(date(2026, 10, 5), 42, secret) == 0
    output = capsys.readouterr().out
    assert "already seeded" in output
    assert "work_orders=600" in output
    assert "Photos: 0" in output
    assert secret not in output

    app = create_app(Settings(database_url=url, allowed_hosts=["testserver"]))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        login = await client.post(
            "/api/v1/auth/login", json={"login": "demo.admin", "secret": secret}
        )
        assert login.status_code == 200
        headers = {"Authorization": "Bearer " + login.json()["access_token"]}
        catalog = await client.get("/api/v1/catalog", headers=headers)
        assert catalog.status_code == 200
        data = catalog.json()
        for key, expected in {
            "areas": 4,
            "equipment": 25,
            "brigades": 3,
            "fault_codes": 20,
            "materials": 40,
        }.items():
            assert len(data[key]) == expected
        employees = await client.get("/api/v1/catalog/employees", headers=headers)
        assert employees.status_code == 200
        assert len(employees.json()) == 19
        assert "password_hash" not in employees.text
        assert secret not in employees.text
        manager = await client.post(
            "/api/v1/auth/login", json={"login": "demo.manager", "secret": secret}
        )
        assert manager.status_code == 200
        manager_headers = {"Authorization": "Bearer " + manager.json()["access_token"]}
        manager_catalog = await client.get("/api/v1/catalog", headers=manager_headers)
        assert manager_catalog.status_code == 200
        assert len(manager_catalog.json()["areas"]) == 4
        assert len(manager_catalog.json()["equipment"]) == 25


def test_cli_reports_missing_database_without_traceback(monkeypatch, capsys):
    monkeypatch.setenv("NARYADAI_DEMO_SECRET", "private-cli-secret")
    assert main(["--anchor", "2026-10-05"]) == 2
    output = capsys.readouterr()
    assert "NARYADAI_DATABASE_URL is required" in output.out
    assert "private-cli-secret" not in output.out
    assert "Traceback" not in output.err
