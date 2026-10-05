import json
import logging
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from naryadai.app import create_app
from naryadai.config import Settings
from naryadai.observability import JsonFormatter, RequestContextMiddleware


def test_formatter_outputs_only_approved_fields():
    record = logging.LogRecord("test", logging.INFO, "", 0, "http_request", (), None)
    record.request_id = "test-id"
    record.authorization = "secret"
    payload = json.loads(JsonFormatter().format(record))
    assert payload["request_id"] == "test-id"
    assert payload["level"] == "INFO"
    assert payload["event"] == "http_request"
    assert "+00:00" in payload["timestamp"]
    assert "authorization" not in payload


def test_logs_contain_route_template_not_path_or_query(monkeypatch):
    captured = []
    logger = logging.getLogger("naryadai.access")
    monkeypatch.setattr(logger, "info", lambda message, **kwargs: captured.append(kwargs["extra"]))
    app = create_app(Settings(allowed_hosts=["testserver"]))

    @app.get("/items/{item_id}")
    async def item(item_id: str):
        return {"id": item_id}

    with TestClient(app) as client:
        client.get("/items/private-person?token=secret")
        client.get("/unmatched-private-person")
    assert captured[0]["route"] == "/items/{item_id}"
    assert captured[1]["route"] == "[unmatched]"
    assert "private-person" not in json.dumps(captured)
    assert "secret" not in json.dumps(captured)


def test_non_http_scope_is_passed_through():
    import asyncio

    inner = AsyncMock()
    middleware = RequestContextMiddleware(inner, logging.getLogger("test"))
    receive, send = AsyncMock(), AsyncMock()
    scope = {"type": "lifespan"}
    asyncio.run(middleware(scope, receive, send))
    inner.assert_awaited_once_with(scope, receive, send)
