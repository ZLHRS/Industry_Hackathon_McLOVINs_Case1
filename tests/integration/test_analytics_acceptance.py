from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi import HTTPException

from naryadai.analytics.contracts import AnalyticsQuery
from naryadai.analytics.service import analytics_options, build_report
from naryadai.api.analytics import analytics_query
from naryadai.application.common import OperationError
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import ActorRole, AiAssessment, WorkOrderStatus
from naryadai.infrastructure.models import (
    AIReview,
    Area,
    Brigade,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    Priority,
    TimeNorm,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

pytestmark = pytest.mark.asyncio


def at(d, h, m=0):
    return datetime(2026, 6, d, h, m, tzinfo=UTC)


def q(d):
    return AnalyticsQuery(period="custom", **{"from": at(d, 0), "to": at(d + 1, 0)}, timezone="UTC")


def pr(e, *a):
    return Principal(e.id, uuid4(), e.login, e.display_name, str(e.role), a)


async def seed(db):
    async with db.sessions.begin() as s:
        a, x = Area(code="AA", name="A"), Area(code="AX", name="X")
        b = Brigade(code="AB", name="B")
        s.add_all((a, x, b))
        await s.flush()
        m = Employee(
            login="am", display_name="M", role="master", specialty="m", grade=5, password_hash="x"
        )
        e = Employee(
            login="ae",
            display_name="E",
            role="executor",
            specialty="m",
            grade=4,
            brigade_id=b.id,
            password_hash="x",
        )
        f = Employee(
            login="af",
            display_name="F",
            role="executor",
            specialty="m",
            grade=4,
            brigade_id=b.id,
            password_hash="x",
        )
        s.add_all((m, e, f))
        await s.flush()
        s.add_all(
            (
                EmployeeArea(employee_id=m.id, area_id=a.id),
                EmployeeArea(employee_id=e.id, area_id=a.id),
                EmployeeArea(employee_id=f.id, area_id=a.id),
            )
        )
        eq = Equipment(
            inventory_number="AP", name="P", area_id=a.id, equipment_type="pump", criticality=4
        )
        fc = FaultCode(code="AF", name="F", specialty="m")
        mat = Material(code="AM", name="M", unit="pc")
        s.add_all((eq, fc, mat))
        await s.flush()
        s.add(TimeNorm(fault_code_id=fc.id, equipment_type="pump", minutes=600))
        seq = {}

        def o(
            n,
            ex=e,
            status=WorkOrderStatus.ISSUED,
            dl=None,
            st=None,
            co=None,
            cl=None,
            attempt=1,
        ):
            z = WorkOrder(
                number="A" + n,
                work_type=WorkType.UNPLANNED,
                description=n,
                area_id=a.id,
                equipment_id=eq.id,
                executor_id=ex.id,
                master_id=m.id,
                priority=Priority.HIGH,
                status=status,
                issued_at=at(1, 0),
                deadline=dl or at(1, 23),
                started_at=st,
                completed_at=co,
                closed_at=cl,
                fault_code_id=fc.id,
                version=9,
                attempt=attempt,
            )
            s.add(z)
            return z

        def ev(z, act, when, status, who=e, d=None):
            seq[z.id] = seq.get(z.id, 0) + 1
            s.add(
                WorkOrderEvent(
                    work_order_id=z.id,
                    sequence=seq[z.id],
                    order_version=seq[z.id],
                    action=act,
                    occurred_at=when,
                    actor_id=who.id,
                    actor_role=ActorRole.EXECUTOR,
                    from_status=None,
                    to_status=status,
                    details=d or {},
                )
            )

        # Historical state, reassignment activity, and two material versions.
        z = o(
            "L", status=WorkOrderStatus.CLOSED, dl=at(1, 3), st=at(1, 1), co=at(2, 1), cl=at(2, 2)
        )
        await s.flush()
        ev(z, "close", at(2, 2), WorkOrderStatus.CLOSED, m)
        z = o("R", f, WorkOrderStatus.COMPLETED, at(2, 23), at(1, 3, 30), at(1, 4, 30))
        await s.flush()
        ev(z, "start", at(1, 0, 30), WorkOrderStatus.IN_PROGRESS, e)
        ev(z, "pause", at(1, 1, 30), WorkOrderStatus.PAUSED, e)
        ev(z, "resume", at(1, 2, 30), WorkOrderStatus.IN_PROGRESS, e)
        ev(z, "reassign", at(1, 3, 30), WorkOrderStatus.ISSUED, m)
        ev(z, "start", at(1, 3, 30), WorkOrderStatus.IN_PROGRESS, f)
        ev(z, "complete", at(1, 4, 30), WorkOrderStatus.COMPLETED, f)
        z = o(
            "V",
            status=WorkOrderStatus.CLOSED,
            dl=at(3, 23),
            st=at(1, 4),
            co=at(2, 4),
            cl=at(2, 5),
            attempt=2,
        )
        await s.flush()
        ev(z, "complete", at(1, 5), WorkOrderStatus.COMPLETED, e, {"submission_version": 3})
        ev(z, "complete", at(2, 4), WorkOrderStatus.COMPLETED, e, {"submission_version": 6})
        s.add_all(
            (
                MaterialUsage(
                    work_order_id=z.id,
                    material_id=mat.id,
                    quantity=Decimal("1"),
                    submission_version=3,
                ),
                MaterialUsage(
                    work_order_id=z.id,
                    material_id=mat.id,
                    quantity=Decimal("9"),
                    submission_version=6,
                ),
            )
        )
        # Review master-score priority, timely/late close, rework maturity, norm workload.
        rows = []
        for n, st, co, cl, dl, attempt, score, master in (
            ("G", at(1, 7), at(1, 8), at(1, 9), at(1, 12), 1, 2, 4),
            ("W", at(1, 10), at(1, 11), at(1, 13), at(1, 12), 2, 5, None),
        ):
            z = o(n, status=WorkOrderStatus.CLOSED, dl=dl, st=st, co=co, cl=cl, attempt=attempt)
            rows.append((z, score, master))
        await s.flush()
        for z, score, master in rows:
            ev(
                z, "request_rework", z.completed_at, WorkOrderStatus.REWORK, e
            ) if z.attempt > 1 else None
            ev(z, "close", z.closed_at, WorkOrderStatus.CLOSED, m)
            s.add(
                AIReview(
                    work_order_id=z.id,
                    order_version=5,
                    verdict=AiAssessment.ACCEPTED,
                    score=score,
                    master_score=master,
                    explanation="x",
                    model_name="t",
                    created_at=z.completed_at,
                )
            )
        # Late downtime correction [05,07] overlaps second [06,08] => union 3h.
        d1, d2 = o("D1", dl=at(3, 23)), o("D2", dl=at(3, 23))
        await s.flush()
        ev(
            d1,
            "record_downtime",
            at(1, 9),
            WorkOrderStatus.ISSUED,
            e,
            {"started_at": at(1, 5).isoformat(), "ended_at": at(1, 9).isoformat()},
        )
        ev(
            d1,
            "record_downtime",
            at(4, 9),
            WorkOrderStatus.ISSUED,
            e,
            {"started_at": at(1, 5).isoformat(), "ended_at": at(1, 7).isoformat()},
        )
        ev(
            d2,
            "record_downtime",
            at(1, 9),
            WorkOrderStatus.ISSUED,
            e,
            {"started_at": at(1, 6).isoformat(), "ended_at": at(1, 8).isoformat()},
        )
    return {
        "a": a.id,
        "x": x.id,
        "m": pr(m, a.id),
        "e": pr(e, a.id),
        "eid": e.id,
        "fid": f.id,
        "bid": b.id,
        "mat": mat.id,
    }


async def test_analytics_historical_contract(database):
    d = await seed(database)
    r = await build_report(database, d["m"], q(1))
    r2 = await build_report(database, d["m"], q(2))
    assert r.orders.overdue == 1
    active = {x.employee_id: x for x in r.activity.by_employee}
    assert active[d["eid"]].active_seconds == pytest.approx(7200)
    assert active[d["eid"]].paused_seconds == pytest.approx(3600)
    assert active[d["fid"]].active_seconds == pytest.approx(3600)
    assert [(x.material_id, x.quantity) for x in r.materials.usage] == [(d["mat"], 1.0)]
    assert [(x.material_id, x.quantity) for x in r2.materials.usage] == [(d["mat"], 9.0)]
    assert r.downtime.known_seconds == pytest.approx(10800)


async def test_ratings_scope_and_invalid_query(database):
    d = await seed(database)
    r = await build_report(database, d["m"], q(1))
    e = next(x for x in r.ratings.employees if x.subject_id == d["eid"])
    b = next(x for x in r.ratings.brigades if x.subject_id == d["bid"])
    assert (
        e.sample_size == 2
        and e.components["quality"].value == pytest.approx(0.9)
        and e.components["timeliness"].value == pytest.approx(1)
        and e.components["rework"].value == pytest.approx(0.5)
        and e.components["volume"].value == pytest.approx(1)
        and "refusal" in e.unavailable_components
        and e.score == pytest.approx(85.26, abs=0.01)
    )
    assert b.sample_size == 2 and b.score == pytest.approx(e.score)
    own = await build_report(database, d["e"], q(1))
    assert (
        own.ratings.brigades == []
        and own.anomalies == []
        and [x.id for x in (await analytics_options(database, d["e"])).areas] == [d["a"]]
    )
    with pytest.raises(OperationError, match="analytics_area_not_found"):
        await build_report(
            database,
            d["m"],
            AnalyticsQuery(
                period="custom",
                **{"from": at(1, 0), "to": at(2, 0)},
                timezone="UTC",
                area_ids=(d["x"],),
            ),
        )
    with pytest.raises(HTTPException) as bad:
        await analytics_query(
            period="custom",
            shift=None,
            date=None,
            from_=at(2, 0),
            to=at(1, 0),
            timezone="UTC",
            area_id=[],
            equipment_id=[],
            executor_id=[],
            brigade_id=[],
        )
    assert bad.value.status_code == 422
