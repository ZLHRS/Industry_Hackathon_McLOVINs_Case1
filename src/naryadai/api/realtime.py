"""Authenticated invalidation stream; PostgreSQL remains the state authority."""

import asyncio
import json
from collections import Counter
from contextlib import suppress
from time import monotonic
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from starlette.types import Message

from naryadai.auth.dependencies import authenticate_token
from naryadai.config import Settings
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import RealtimeRevision

router = APIRouter(tags=["realtime"])


class ConnectionLimits:
    """Per-process bounds; manipulated only on the application's event loop."""

    def __init__(self) -> None:
        self.total = 0
        self.actors: Counter[str] = Counter()


def allowed_origin(websocket: WebSocket, settings: Settings) -> bool:
    origin = websocket.headers.get("origin")
    scheme = "https" if websocket.url.scheme == "wss" else "http"
    same_origin = f"{scheme}://{websocket.headers.get('host', '')}"
    return bool(origin and origin in {same_origin, *settings.cors_origins})


async def _send(websocket: WebSocket, message: dict[str, Any]) -> None:
    await asyncio.wait_for(websocket.send_json(message), timeout=5)


@router.websocket("/realtime")
async def realtime(websocket: WebSocket) -> None:
    settings: Settings = websocket.app.state.settings
    database = getattr(websocket.app.state, "database", None)
    limits: ConnectionLimits = websocket.app.state.realtime_limits
    if not isinstance(database, Database) or not allowed_origin(websocket, settings):
        await websocket.close(code=1008)
        return
    if limits.total >= 100 or websocket.query_params:
        await websocket.close(code=1008)
        return
    limits.total += 1
    actor_key: str | None = None
    receiver: asyncio.Task[Message] | None = None
    try:
        await websocket.accept()
        frame = await asyncio.wait_for(websocket.receive(), timeout=5)
        raw = frame.get("text")
        if not isinstance(raw, str) or len(raw) > 256:
            await websocket.close(code=1008)
            return
        try:
            message = json.loads(raw)
        except (ValueError, TypeError):
            await websocket.close(code=4401)
            return
        if not isinstance(message, dict) or message.get("type") != "authenticate":
            await websocket.close(code=4401)
            return
        token = message.get("token")
        if not isinstance(token, str):
            await websocket.close(code=4401)
            return
        principal = await authenticate_token(database, token)
        if principal is None:
            await websocket.close(code=4401)
            return
        if principal.role == "admin":
            await websocket.close(code=4403)
            return
        actor_key = str(principal.employee_id)
        if limits.actors[actor_key] >= 4:
            actor_key = None
            await websocket.close(code=4429)
            return
        limits.actors[actor_key] += 1
        async with database.sessions() as session:
            revision = (
                await session.scalar(
                    select(RealtimeRevision.revision).where(
                        RealtimeRevision.employee_id == principal.employee_id
                    )
                )
                or 0
            )
        await _send(websocket, {"type": "ready", "revision": revision})
        heartbeat_at = monotonic()
        receiver = asyncio.create_task(websocket.receive())
        while True:
            done, _ = await asyncio.wait({receiver}, timeout=settings.realtime_poll_seconds)
            if done:
                # The protocol only accepts authentication once; no unbounded command queue.
                frame = receiver.result()
                if frame["type"] != "websocket.disconnect":
                    await websocket.close(code=1008)
                return
            live = await authenticate_token(database, token)
            if live is None:
                await websocket.close(code=4401)
                return
            async with database.sessions() as session:
                latest = (
                    await session.scalar(
                        select(RealtimeRevision.revision).where(
                            RealtimeRevision.employee_id == live.employee_id
                        )
                    )
                    or 0
                )
            if latest != revision:
                revision = latest
                await _send(websocket, {"type": "refresh", "revision": revision})
                heartbeat_at = monotonic()
            elif monotonic() - heartbeat_at >= 15:
                await _send(websocket, {"type": "heartbeat"})
                heartbeat_at = monotonic()
    except (TimeoutError, WebSocketDisconnect, OSError, RuntimeError, SQLAlchemyError):
        with suppress(RuntimeError, WebSocketDisconnect, OSError):
            await websocket.close(code=1011)
    finally:
        if receiver is not None:
            receiver.cancel()
            with suppress(asyncio.CancelledError, RuntimeError, WebSocketDisconnect, OSError):
                await receiver
        limits.total -= 1
        if actor_key is not None:
            limits.actors[actor_key] -= 1
            if not limits.actors[actor_key]:
                del limits.actors[actor_key]
