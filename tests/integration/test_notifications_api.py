"""Private inbox, session-bound subscriptions and actual TCP WebSocket contracts."""

import asyncio
import base64
import json
import socket
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
import uvicorn
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from sqlalchemy import select
from test_order_api import api as api
from test_order_api import issue
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from naryadai.app import create_app
from naryadai.config import Settings
from naryadai.infrastructure.models import (
    AuthSession,
    Notification,
    PushSubscription,
    RealtimeRevision,
    WorkOrder,
)

pytestmark = pytest.mark.asyncio


async def seed_notification(database, api, *, who="executor"):
    order = await issue(api)
    async with database.sessions.begin() as session:
        note = Notification(
            employee_id=api["users"][who],
            work_order_id=UUID(order["order_id"]),
            dedup_key=str(uuid4()),
            kind="issued",
            title="Новый наряд",
            body="Проверьте наряд",
            urgent=True,
            action_required=True,
            payload={},
        )
        session.add(note)
        await session.flush()
        return note.id, order["order_id"]


async def test_inbox_scope_read_ack_and_lifecycle_unchanged(api, database):
    note_id, order_id = await seed_notification(database, api)
    client, headers = api["client"], api["headers"]
    path = "/api/v1/notifications"
    assert (await client.get(path)).status_code == 401
    for who in ("master", "manager", "coworker", "foreign"):
        response = await client.get(path, headers=headers[who])
        assert response.json() == {"items": [], "total": 0, "unread_count": 0}
        assert (await client.post(f"{path}/{note_id}/ack", headers=headers[who])).status_code == 404
    assert (await client.get(path, headers=headers["admin"])).status_code == 403
    inbox = (await client.get(path, headers=headers["executor"])).json()
    assert inbox["total"] == inbox["unread_count"] == 1
    assert inbox["items"][0]["order_id"] == order_id
    assert (await client.get(f"{path}/{note_id}", headers=headers["executor"])).json()[
        "order_id"
    ] == order_id
    assert (await client.get(f"{path}/{note_id}", headers=headers["coworker"])).status_code == 404
    read = await client.post(f"{path}/{note_id}/read", headers=headers["executor"])
    assert read.status_code == 200
    again = await client.post(f"{path}/{note_id}/read", headers=headers["executor"])
    assert read.json() == again.json()
    ack = await client.post(f"{path}/{note_id}/ack", headers=headers["executor"])
    assert ack.json()["acknowledged_at"] is not None
    assert ack.json()["read_at"] == read.json()["read_at"]
    assert (
        await client.post(f"{path}/{note_id}/ack", headers=headers["executor"])
    ).json() == ack.json()
    unseen = (await client.get(path + "?unread_only=true", headers=headers["executor"])).json()
    assert unseen == {"items": [], "total": 0, "unread_count": 0}
    async with database.sessions() as session:
        assert (await session.get(WorkOrder, UUID(order_id))).status == "issued"
        assert (await session.get(RealtimeRevision, api["users"]["executor"])).revision == 2


async def test_inbox_pagination_and_assignment_revocation(api, database):
    first, order_id = await seed_notification(database, api)
    await seed_notification(database, api)
    client, headers = api["client"], api["headers"]["executor"]
    page = (await client.get("/api/v1/notifications?limit=1", headers=headers)).json()
    next_page = (await client.get("/api/v1/notifications?limit=1&offset=1", headers=headers)).json()
    assert page["total"] == next_page["unread_count"] == 2
    assert page["items"][0]["id"] != next_page["items"][0]["id"]
    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, UUID(order_id))
        order.executor_id = api["users"]["coworker"]
    page = (await client.get("/api/v1/notifications", headers=headers)).json()
    assert page["total"] == 1
    assert (
        await client.post(f"/api/v1/notifications/{first}/read", headers=headers)
    ).status_code == 404


def push_body(index=0):
    key = (
        ec.generate_private_key(ec.SECP256R1())
        .public_key()
        .public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    )

    def encode(value):
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode()

    return {
        "endpoint": f"https://fcm.googleapis.com/send/test-{index}",
        "keys": {"p256dh": encode(key), "auth": encode(b"0123456789abcdef")},
    }


async def test_push_configuration_validation_rebind_and_unsubscribe(api, database, monkeypatch):
    client, headers = api["client"], api["headers"]
    prefix = "/api/v1/notifications"
    result = await client.get(prefix + "/push-config", headers=headers["executor"])
    assert result.json() == {"enabled": False, "public_key": None}
    assert (
        await client.post(prefix + "/subscriptions", json=push_body(), headers=headers["executor"])
    ).status_code == 503
    monkeypatch.setattr("naryadai.api.notifications.push_enabled", lambda settings: True)
    monkeypatch.setattr("naryadai.api.notifications.public_key", lambda settings: "public")
    assert (await client.get(prefix + "/push-config", headers=headers["executor"])).json()[
        "public_key"
    ] == "public"
    body = push_body()
    bad = body | {"endpoint": "https://127.0.0.1/private"}
    assert (
        await client.post(prefix + "/subscriptions", json=bad, headers=headers["executor"])
    ).status_code == 422
    bad = body | {"keys": body["keys"] | {"auth": "A" * 24}}
    assert (
        await client.post(prefix + "/subscriptions", json=bad, headers=headers["executor"])
    ).status_code == 422
    created = await client.post(prefix + "/subscriptions", json=body, headers=headers["executor"])
    assert created.status_code == 201, created.text
    subscription_id = created.json()["id"]
    again = await client.post(prefix + "/subscriptions", json=body, headers=headers["executor"])
    assert again.json() == created.json()
    # A browser endpoint follows the new account; delivery ownership is rechecked.
    rebound = await client.post(prefix + "/subscriptions", json=body, headers=headers["coworker"])
    assert rebound.json() == created.json()
    path = prefix + "/subscriptions/" + subscription_id
    assert (await client.delete(path, headers=headers["executor"])).status_code == 404
    assert (await client.delete(path, headers=headers["coworker"])).status_code == 204
    assert (await client.delete(path, headers=headers["coworker"])).status_code == 204
    async with database.sessions() as session:
        subscription = await session.get(PushSubscription, UUID(subscription_id))
        assert subscription.disabled_at is not None
        assert subscription.employee_id == api["users"]["coworker"]
    assert (
        await client.delete(prefix + "/subscriptions/" + str(uuid4()), headers=headers["coworker"])
    ).status_code == 404


async def test_push_device_limit_and_role(api, monkeypatch):
    monkeypatch.setattr("naryadai.api.notifications.push_enabled", lambda settings: True)
    path = "/api/v1/notifications/subscriptions"
    for index in range(10):
        result = await api["client"].post(
            path, json=push_body(index), headers=api["headers"]["executor"]
        )
        assert result.status_code == 201
    assert (
        await api["client"].post(path, json=push_body(10), headers=api["headers"]["executor"])
    ).status_code == 409
    assert (
        await api["client"].post(path, json=push_body(11), headers=api["headers"]["admin"])
    ).status_code == 403


@asynccontextmanager
async def tcp_server(database):
    app = create_app(
        Settings(
            database_url=database.engine.url.render_as_string(hide_password=False),
            allowed_hosts=["127.0.0.1"],
            realtime_poll_seconds=0.1,
        )
    )
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, log_level="error", access_log=False, ws="websockets-sansio")
    )
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        yield f"ws://127.0.0.1:{port}/api/v1/realtime", f"http://127.0.0.1:{port}", app
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        sock.close()


async def authenticate(ws, api, who="executor"):
    await ws.send(
        json.dumps({"type": "authenticate", "token": api["headers"][who]["Authorization"][7:]})
    )
    return json.loads(await asyncio.wait_for(ws.recv(), 2))


async def test_websocket_refresh_private_revisions_and_revocation(api, database):
    async with tcp_server(database) as (url, origin, app):
        async with connect(url, origin=origin) as worker, connect(url, origin=origin) as colleague:
            assert await authenticate(worker, api) == {"type": "ready", "revision": 0}
            assert await authenticate(colleague, api, "coworker") == {
                "type": "ready",
                "revision": 0,
            }
            async with database.sessions.begin() as session:
                session.add(RealtimeRevision(employee_id=api["users"]["executor"], revision=9))
            assert json.loads(await asyncio.wait_for(worker.recv(), 2)) == {
                "type": "refresh",
                "revision": 9,
            }
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(colleague.recv(), 0.3)
            async with database.sessions.begin() as session:
                rows = await session.scalars(
                    select(AuthSession).where(AuthSession.employee_id == api["users"]["executor"])
                )
                for row in rows:
                    row.revoked_at = datetime.now(UTC)
            with pytest.raises(ConnectionClosed) as closed:
                await asyncio.wait_for(worker.recv(), 2)
            assert closed.value.rcvd.code == 4401
        await asyncio.sleep(0.1)
        assert app.state.realtime_limits.total == 0
        assert not app.state.realtime_limits.actors


async def test_websocket_origin_protocol_auth_and_actor_limit(api, database):
    async with tcp_server(database) as (url, origin, app):
        for kwargs in ({}, {"origin": "https://evil.example"}, {"origin": "null"}):
            with pytest.raises(InvalidStatus):
                async with connect(url, **kwargs):
                    pass
        with pytest.raises(InvalidStatus):
            async with connect(url + "?token=never-here", origin=origin):
                pass
        for message, expected in [
            ("not-json", 4401),
            ("[]", 4401),
            ('{"type":"authenticate","token":4}', 4401),
            ('{"type":"authenticate","token":"bad"}', 4401),
            ("X" * 257, 1008),
        ]:
            async with connect(url, origin=origin) as ws:
                await ws.send(message)
                with pytest.raises(ConnectionClosed) as closed:
                    await ws.recv()
                assert closed.value.rcvd.code == expected
        async with connect(url, origin=origin) as ws:
            with pytest.raises(ConnectionClosed) as closed:
                await authenticate(ws, api, "admin")
            assert closed.value.rcvd.code == 4403
        sockets = []
        try:
            for _ in range(4):
                ws = await connect(url, origin=origin)
                sockets.append(ws)
                assert (await authenticate(ws, api))["type"] == "ready"
            async with connect(url, origin=origin) as ws:
                with pytest.raises(ConnectionClosed) as closed:
                    await authenticate(ws, api)
                assert closed.value.rcvd.code == 4429
            await sockets[0].send('{"type":"unexpected"}')
            with pytest.raises(ConnectionClosed) as closed:
                await sockets[0].recv()
            assert closed.value.rcvd.code == 1008
        finally:
            for ws in sockets:
                await ws.close()
        await asyncio.sleep(0.1)
        assert app.state.realtime_limits.total == 0
