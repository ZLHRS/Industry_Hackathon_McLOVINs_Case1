"""Provider contract checks: only a typed intent may cross the boundary."""

import json

import httpx2
import pytest
from pydantic import SecretStr

from naryadai.ai import master_assistant
from naryadai.ai.contracts import OpenAIReviewConfig
from naryadai.application.master_assistant import _has_unsupported_filter, _rules_topic

pytestmark = pytest.mark.asyncio


def _config() -> OpenAIReviewConfig:
    return OpenAIReviewConfig(
        api_key=SecretStr("unit-test-secret"),
        model="gpt-5.4",
        reasoning_effort="low",
        request_timeout_seconds=2,
        total_timeout_seconds=3,
        max_output_tokens=2048,
    )


async def test_master_assistant_common_attention_chip_phrase_is_local() -> None:
    assert _rules_topic("Что сейчас требует внимания?") == "attention"


@pytest.mark.parametrize(
    "question",
    ["повторы за последние 7 дней", "история за 30 дней", "repeats past 7 days"],
)
async def test_master_assistant_rejects_custom_time_windows(question: str) -> None:
    assert _has_unsupported_filter(question)


async def test_master_assistant_intent_is_strict_and_question_only(monkeypatch):
    seen: dict[str, object] = {}

    async def handler(request: httpx2.Request) -> httpx2.Response:
        payload = json.loads(request.content)
        seen["payload"] = payload
        return httpx2.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": json.dumps(
                                    {
                                        "topic": "accepted_repair_history",
                                        "equipment_code": "M-01",
                                        "search_text": "seal leak",
                                    }
                                ),
                            }
                        ],
                    }
                ],
            },
        )

    original = master_assistant.httpx2.AsyncClient

    def factory(**kwargs: object) -> httpx2.AsyncClient:
        return original(transport=httpx2.MockTransport(handler), **kwargs)

    monkeypatch.setattr(master_assistant.httpx2, "AsyncClient", factory)
    intent = await master_assistant.classify_intent("Find accepted seal repairs", _config())
    assert intent is not None and intent.topic == "accepted_repair_history"
    payload = seen["payload"]
    assert isinstance(payload, dict) and payload["store"] is False
    user = payload["input"][1]["content"][0]["text"]
    assert user == "Find accepted seal repairs"


async def test_master_assistant_invalid_provider_plan_falls_back(monkeypatch):
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            json={
                "status": "completed",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "{}"}]}],
            },
        )

    original = master_assistant.httpx2.AsyncClient

    def factory(**kwargs: object) -> httpx2.AsyncClient:
        return original(transport=httpx2.MockTransport(handler), **kwargs)

    monkeypatch.setattr(master_assistant.httpx2, "AsyncClient", factory)
    assert await master_assistant.classify_intent("unclear", _config()) is None


async def test_master_assistant_provider_schema_requires_every_plan_field(monkeypatch):
    async def handler(request: httpx2.Request) -> httpx2.Response:
        payload = json.loads(request.content)
        schema = payload["text"]["format"]["schema"]
        assert set(schema["required"]) == {"topic", "equipment_code", "search_text"}
        assert payload["max_output_tokens"] == 2048
        return httpx2.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": json.dumps(
                                    {
                                        "topic": "attention",
                                        "equipment_code": None,
                                        "search_text": None,
                                    }
                                ),
                            }
                        ],
                    }
                ],
            },
        )

    original = master_assistant.httpx2.AsyncClient

    def factory(**kwargs: object) -> httpx2.AsyncClient:
        return original(transport=httpx2.MockTransport(handler), **kwargs)

    monkeypatch.setattr(master_assistant.httpx2, "AsyncClient", factory)
    intent = await master_assistant.classify_intent("Need attention", _config())
    assert intent is not None and intent.topic == "attention"


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(500, content=b"provider-private-detail"),
        httpx2.Response(200, json={"status": "in_progress", "output": []}),
        httpx2.Response(200, content=b"x" * 16_385),
    ],
    ids=["http_error", "refusal_or_incomplete", "oversize"],
)
async def test_master_assistant_provider_failures_are_safe(monkeypatch, response):
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return response

    original = master_assistant.httpx2.AsyncClient

    def factory(**kwargs: object) -> httpx2.AsyncClient:
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        return original(transport=httpx2.MockTransport(handler), **kwargs)

    monkeypatch.setattr(master_assistant.httpx2, "AsyncClient", factory)
    assert await master_assistant.classify_intent("unclear", _config()) is None
