"""HTTP-only probe, mounted into a disposable recovery container by verify_operations."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from httpx2 import AsyncClient

STATE = Path("/probe-state/session.json")


def require(value: bool, message: str) -> None:
    if not value:
        raise RuntimeError(message)


async def probe(mode: str, payload: dict) -> dict:
    async with AsyncClient(base_url=payload["base_url"], timeout=15) as client:
        if mode == "ready":
            for _ in range(40):
                try:
                    response = await client.get("/api/v1/health/ready")
                    if response.status_code == 200:
                        return {"ready": True}
                except Exception:
                    pass
                await asyncio.sleep(0.25)
            raise RuntimeError("restored_api_not_ready")
        if mode == "baseline":
            login = await client.post("/api/v1/auth/login", json=payload["credentials"])
            require(login.status_code == 200, "restored_login_failed")
            headers = {"Authorization": "Bearer " + login.json()["access_token"]}
            me = await client.get("/api/v1/auth/me", headers=headers)
            require(me.status_code == 200 and me.json()["role"] == "master", "restored_role_failed")
            static = await client.get("/")
            require(
                static.status_code == 200 and "<html" in static.text, "restored_frontend_failed"
            )
            manifest = await client.get("/manifest.webmanifest")
            require(
                manifest.status_code == 200 and bool(manifest.json()["name"]), "manifest_failed"
            )
            require(
                (await client.get("/api/v1/catalog")).status_code == 401, "anonymous_read_allowed"
            )
            catalogue = await client.get("/api/v1/catalog", headers=headers)
            require(catalogue.status_code == 200, "restored_catalog_failed")
            workload = (await client.get("/api/v1/workload", headers=headers)).json()
            machine = next(m for m in catalogue.json()["equipment"] if m["is_active"])
            person = next(
                p for p in workload if p["is_on_shift"] and machine["area_id"] in p["area_ids"]
            )
            body = {
                "work_type": "planned",
                "priority": "normal",
                "description": "Изолированная проверка восстановления " + uuid4().hex,
                "area_id": machine["area_id"],
                "equipment_id": machine["id"],
                "executor_id": person["employee_id"],
                "deadline": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
            }
            key = uuid4().hex
            response = await client.post(
                "/api/v1/work-orders", headers=headers | {"Idempotency-Key": key}, json=body
            )
            require(response.status_code == 201, "restored_write_failed")
            mutation = response.json()
            path = f"/api/v1/work-orders/{mutation['order_id']}"
            first = (await client.get(path, headers=headers)).json()
            require(first["description"] == body["description"], "write_read_mismatch")
            archive_photos = 0
            for photo in payload["photos"]:
                photo_path = f"/api/v1/work-orders/{photo['work_order_id']}/photos/{photo['id']}"
                require(
                    (await client.get(photo_path)).status_code == 401, "anonymous_photo_allowed"
                )
                response = await client.get(photo_path, headers=headers)
                # A master may only see their areas; verify accessible referenced photos.
                if response.status_code == 404:
                    continue
                require(response.status_code == 200, "restored_photo_failed")
                require(
                    hashlib.sha256(response.content).hexdigest() == photo["sha256"],
                    "restored_photo_hash_failed",
                )
                archive_photos += 1
            require(not payload["photos"] or archive_photos > 0, "no_photo_access_verified")
            os.umask(0o077)
            STATE.write_text(
                json.dumps(
                    {
                        "headers": headers,
                        "body": body,
                        "key": key,
                        "mutation": mutation,
                        "detail": first,
                    }
                )
            )
            return {
                "login": "PASS",
                "frontend": "PASS",
                "manifest": "PASS",
                "anonymous_denied": True,
                "write_read": "PASS",
                "authenticated_photo_hashes_checked": archive_photos,
            }
        state = json.loads(STATE.read_text())
        headers = state["headers"]
        if mode == "replay":
            require(
                (await client.get("/api/v1/auth/me", headers=headers)).status_code == 200,
                "session_lost_after_restart",
            )
            response = await client.post(
                "/api/v1/work-orders",
                headers=headers | {"Idempotency-Key": state["key"]},
                json=state["body"],
            )
            require(
                response.status_code == 201 and response.json() == state["mutation"],
                "retry_created_duplicate",
            )
            order_id = state["mutation"]["order_id"]
            response = await client.get(f"/api/v1/work-orders/{order_id}", headers=headers)
            require(
                response.status_code == 200 and response.json()["version"] == 1,
                "restart_changed_order",
            )
            events = await client.get(f"/api/v1/work-orders/{order_id}/events", headers=headers)
            require(
                events.status_code == 200 and len(events.json()["items"]) == 1,
                "duplicate_audit_event",
            )
            return {"session_survived": True, "idempotent_retry": True, "single_issue_event": True}
        if mode == "load":
            paths = [
                "/api/v1/work-orders?limit=20",
                "/api/v1/catalog",
                "/api/v1/workload",
                "/api/v1/analytics/report?period=month",
                "/api/v1/notifications",
                "/api/v1/auth/me",
            ]
            gate = asyncio.Semaphore(20)
            samples: list[tuple[str, int, float]] = []

            async def one(path: str) -> None:
                async with gate:
                    start = time.perf_counter()
                    response = await client.get(path, headers=headers)
                    samples.append(
                        (path, response.status_code, (time.perf_counter() - start) * 1000)
                    )

            start = time.perf_counter()
            await asyncio.gather(*(one(path) for _ in range(20) for path in paths))
            elapsed = time.perf_counter() - start
            latencies = sorted(row[2] for row in samples)
            failures = sum(row[1] != 200 for row in samples)
            p95 = latencies[math.ceil(len(latencies) * 0.95) - 1]
            result = {
                "concurrency": 20,
                "requests": len(samples),
                "errors": failures,
                "elapsed_seconds": round(elapsed, 3),
                "requests_per_second": round(len(samples) / elapsed, 2),
                "p95_ms": round(p95, 2),
                "max_ms": round(max(latencies), 2),
                "budget_p95_ms": 5000,
                "scope": "Local restored snapshot, authenticated mixed reads; "
                "not an industrial scale guarantee.",
            }
            require(failures == 0, "load_response_failure")
            # Record a slow result as a failed budget, never omit it from the evidence.
            result["status"] = "PASS" if p95 <= 5000 else "FAIL"
            return result
        if mode == "outbox":
            order_id = state["mutation"]["order_id"]
            response = await client.get("/api/v1/health/ready")
            require(response.status_code == 200, "worker_restart_api_unready")
            return {"order_id": order_id}
        raise RuntimeError("unsupported_probe")


if __name__ == "__main__":
    try:
        result = asyncio.run(probe(sys.argv[1], json.load(sys.stdin)))
        print(json.dumps(result))
    except Exception as error:
        # Never expose HTTP/DB credentials or restored record bodies.
        print(
            json.dumps({"status": "FAIL", "error_type": type(error).__name__, "stage": sys.argv[1]})
        )
        raise SystemExit(1) from None
