"""One opt-in external AI request using only synthetic technical text, never the database."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

from naryadai.ai import (
    OpenAIReviewConfig,
    ProviderError,
    ReviewInput,
    ReviewMaterial,
    analyze_review,
)
from naryadai.config import Settings


async def check() -> int:
    settings = Settings()
    if settings.ai_api_key is None:
        print("NARYADAI_AI_API_KEY is missing. Add it to private .env, then run this check again.")
        return 2
    now = datetime.now(UTC)
    example = ReviewInput(
        work_description="Устранить течь уплотнения промышленного насоса.",
        completion_description="Заменено уплотнение, очищено посадочное место. "
        "После сборки проведено испытание под рабочим давлением, течь не обнаружена.",
        equipment_type="pump",
        fault_name="Износ уплотнения",
        materials=(ReviewMaterial(name="Уплотнение", unit="шт", quantity="1"),),
        no_materials_reason=None,
        active_minutes=40,
        paused_minutes=10,
        elapsed_minutes=50,
        norm_minutes=45,
        issued_at=now - timedelta(hours=1),
        completed_at=now,
        photos=(),
    )
    try:
        result = await analyze_review(
            example,
            OpenAIReviewConfig(
                api_key=settings.ai_api_key,
                model=settings.ai_model,
                reasoning_effort=settings.ai_reasoning_effort,
                max_output_tokens=settings.ai_max_output_tokens,
                vision_enabled=False,
                request_timeout_seconds=settings.ai_timeout_seconds,
                total_timeout_seconds=settings.ai_total_timeout_seconds,
            ),
        )
    except ProviderError as error:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "model": settings.ai_model,
                    "error_code": error.code,
                    "retryable": error.retryable,
                    "hint": "Check OpenAI API credits and project spending limits."
                    if error.code == "quota_exhausted"
                    else "Check provider access and configuration.",
                }
            )
        )
        return 1
    print(
        json.dumps(
            {
                "source": result.report["source"],
                "model": result.model_name,
                "needs_master_review": result.needs_master_review,
                "verdict": result.verdict,
                "score": result.score,
                "note": "Synthetic text only; real repair quality is not evaluated.",
            },
            ensure_ascii=False,
        )
    )
    return 0 if result.report["source"] == "openai" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(check()))
