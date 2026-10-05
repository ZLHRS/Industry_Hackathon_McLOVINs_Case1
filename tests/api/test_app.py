from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from naryadai.app import create_app
from naryadai.config import Environment, Settings


def make_app(**overrides):
    return create_app(Settings(allowed_hosts=["testserver"], **overrides))


def test_liveness_and_development_schema():
    with TestClient(make_app()) as client:
        response = client.get("/api/v1/health/live")
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "service": "naryadai"}
        schema = client.get("/openapi.json").json()
        assert schema["info"]["version"] == "0.1.0"
        assert "/api/v1/health/live" in schema["paths"]
        assert client.get("/docs").status_code == 200
        # No readiness endpoint until actual infrastructure probes exist.
        assert client.get("/api/v1/health/ready").status_code == 404


def test_factory_reads_environment_at_call_time(monkeypatch):
    monkeypatch.setenv("NARYADAI_ENVIRONMENT", "test")
    app = create_app()
    assert app.state.settings.environment == Environment.TEST


def test_production_disables_documentation():
    with TestClient(make_app(environment="production")) as client:
        for route in ["/docs", "/redoc", "/openapi.json"]:
            assert client.get(route).status_code == 404
        assert client.get("/api/v1/health/live").status_code == 200


@pytest.mark.parametrize("path", ["/api/v1/health/live", "/missing"])
def test_request_context_and_no_cache(path):
    with TestClient(make_app()) as client:
        first = client.get(path, headers={"X-Request-ID": "untrusted-client-id"})
        second = client.get(path)
        assert UUID(first.headers["X-Request-ID"]).version == 4
        assert first.headers["X-Request-ID"] != second.headers["X-Request-ID"]
        assert first.headers["X-Content-Type-Options"] == "nosniff"
        assert first.headers["Cache-Control"] == "no-store"


def test_untrusted_host_is_rejected():
    with TestClient(make_app()) as client:
        response = client.get("/api/v1/health/live", headers={"Host": "evil.example"})
        assert response.status_code == 400
        assert "X-Request-ID" in response.headers


def test_cors_is_disabled_by_default():
    with TestClient(make_app()) as client:
        response = client.get("/api/v1/health/live", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in response.headers


def test_cors_allows_only_configured_origin():
    with TestClient(make_app(cors_origins=["https://ui.example"])) as client:
        good = client.options(
            "/api/v1/health/live",
            headers={
                "Origin": "https://ui.example",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert good.status_code == 200
        assert good.headers["access-control-allow-origin"] == "https://ui.example"
        bad = client.options(
            "/api/v1/health/live",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert bad.status_code == 400
        assert "access-control-allow-origin" not in bad.headers


def test_unexpected_error_is_sanitized_and_correlated():
    app = make_app()

    @app.get("/broken")
    async def broken():
        raise RuntimeError("private-database-password")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/broken")
        assert response.status_code == 500
        assert response.json() == {
            "detail": "Internal server error",
            "request_id": response.headers["X-Request-ID"],
        }
        assert "private" not in response.text
