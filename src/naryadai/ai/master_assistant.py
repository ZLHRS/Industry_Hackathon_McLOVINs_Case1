"""Strict, data-free intent planning for the master assistant.

The provider sees only the question.  It cannot select database rows or write
the answer: application code validates its tiny plan and renders all facts.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Literal

import httpx2
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from naryadai.ai.contracts import OpenAIReviewConfig

_API_URL = "https://api.openai.com/v1/responses"
_MAX_RESPONSE_BYTES = 16_384
_SYSTEM = (
    "Classify a maintenance master's question. Return only the schema. "
    "Never answer the question, invent facts, IDs, dates, counts, or SQL. "
    "topic is attention, repeated_faults, accepted_repair_history, or unsupported. "
    "Supported windows are current attention, 90-day repeated faults, and 365-day repair history; "
    "mark every other requested date window unsupported. "
    "equipment_code is an exact inventory number only when the user supplied one. "
    "search_text is a short meaningful repair symptom only for accepted_repair_history."
)


class AssistantIntent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    topic: Literal["attention", "repeated_faults", "accepted_repair_history", "unsupported"]
    equipment_code: str | None = Field(..., min_length=1, max_length=64)
    search_text: str | None = Field(..., min_length=2, max_length=120)


async def classify_intent(question: str, config: OpenAIReviewConfig) -> AssistantIntent | None:
    """Return a strictly validated plan, or None without exposing provider failures."""

    if config.api_key is None or not config.api_key.get_secret_value().strip():
        return None
    try:
        response = await _request(question, config)
        plan = _parse(response)
    except (TimeoutError, httpx2.HTTPError, ValueError, ValidationError):
        return None
    if plan.equipment_code is not None and plan.equipment_code != plan.equipment_code.strip():
        return None
    if plan.search_text is not None:
        cleaned = " ".join(plan.search_text.split())
        if not cleaned:
            return None
        plan = plan.model_copy(update={"search_text": cleaned})
    if plan.topic != "accepted_repair_history" and plan.search_text is not None:
        return None
    return plan


async def _request(question: str, config: OpenAIReviewConfig) -> Mapping[str, object]:
    secret = config.api_key.get_secret_value() if config.api_key else ""
    request_timeout = min(config.request_timeout_seconds, 10.0)
    total_timeout = min(max(request_timeout, config.total_timeout_seconds), 12.0)
    payload: dict[str, object] = {
        "model": config.model,
        "store": False,
        "max_output_tokens": config.max_output_tokens,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": _SYSTEM}]},
            {"role": "user", "content": [{"type": "input_text", "text": question}]},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "master_assistant_intent_v1",
                "strict": True,
                "schema": AssistantIntent.model_json_schema(),
            }
        },
    }
    if config.model.startswith(("gpt-5", "gpt-6")):
        payload["reasoning"] = {"effort": config.reasoning_effort}
    async with asyncio.timeout(total_timeout):
        async with (
            httpx2.AsyncClient(
                timeout=httpx2.Timeout(request_timeout), trust_env=False, follow_redirects=False
            ) as client,
            client.stream(
                "POST", _API_URL, headers={"Authorization": f"Bearer {secret}"}, json=payload
            ) as response,
        ):
            if not 200 <= response.status_code < 300:
                raise ValueError("provider_status")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                if len(body) + len(chunk) > _MAX_RESPONSE_BYTES:
                    raise ValueError("provider_response_too_large")
                body.extend(chunk)
    decoded = json.loads(body)
    if not isinstance(decoded, dict):
        raise ValueError("provider_response")
    return decoded


def _parse(response: Mapping[str, object]) -> AssistantIntent:
    if response.get("status") != "completed":
        raise ValueError("provider_response")
    output = response.get("output")
    if not isinstance(output, list):
        raise ValueError("provider_response")
    texts: list[str] = []
    for message in output:
        if not isinstance(message, dict) or message.get("type") != "message":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            raise ValueError("provider_response")
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "output_text":
                raise ValueError("provider_response")
            text = part.get("text")
            if not isinstance(text, str):
                raise ValueError("provider_response")
            texts.append(text)
    if len(texts) != 1:
        raise ValueError("provider_response")
    return AssistantIntent.model_validate_json(texts[0])
