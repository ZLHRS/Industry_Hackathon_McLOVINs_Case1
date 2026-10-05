"""Transparent, bounded components; unavailable evidence is never a penalty."""

# ruff: noqa: RUF001
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timedelta
from uuid import UUID

from naryadai.infrastructure.models import AIReview, WorkOrder, WorkOrderEvent

from .contracts import RatingComponent, RatingsView, RatingView
from .data import Snapshot
from .history import as_uuid, within

WEIGHTS = {"quality": 40, "timeliness": 25, "rework": 20, "volume": 10, "refusal": 5}


def was_reworked(order: WorkOrder, events: list[WorkOrderEvent], cutoff: datetime) -> bool:
    return (not events and order.attempt > 1) or any(
        e.occurred_at <= cutoff and e.to_status.value == "rework" for e in events
    )


def latest_score(order: WorkOrder, snapshot: Snapshot) -> int | None:
    if order.closed_at is None:
        return None
    reviews = [
        r
        for r in snapshot.reviews
        if r.work_order_id == order.id and r.created_at <= order.closed_at
    ]
    closure = next(
        (
            e
            for e in reversed(snapshot.events.get(order.id, []))
            if e.action in {"close", "override_close"} and e.occurred_at <= order.closed_at
        ),
        None,
    )
    if closure and closure.details.get("review_id"):
        linked = as_uuid(closure.details["review_id"])
        reviews = [r for r in reviews if r.id == linked]
    elif order.last_submission_version is not None:
        reviews = [r for r in reviews if r.order_version == order.last_submission_version]
    if not reviews:
        return None
    chosen: AIReview = max(reviews, key=lambda r: (r.order_version, r.created_at, str(r.id)))
    return chosen.master_score if chosen.master_score is not None else chosen.score


def component(
    value: float | None, numerator: float | int | None, denominator: float | int, detail: str
) -> RatingComponent:
    return RatingComponent(
        value=None if value is None else round(value, 6),
        numerator=numerator,
        denominator=denominator,
        detail=detail,
    )


def build_ratings(
    orders: list[WorkOrder],
    snapshot: Snapshot,
    start: datetime,
    end: datetime,
    now: datetime,
    allowed_actors: set[UUID] | None = None,
) -> RatingsView:
    closed = [o for o in orders if within(o.closed_at, start, end)]
    by_person: dict[UUID, list[WorkOrder]] = defaultdict(list)
    for order in closed:
        by_person[order.executor_id].append(order)
    # Assessments can be recorded later than the rejection; snapshot is knowledge as of now.
    judgments: dict[UUID, WorkOrderEvent] = {}
    rejections: dict[UUID, list[WorkOrderEvent]] = defaultdict(list)
    permitted_ids = {o.id for o in orders}
    for oid, events in snapshot.events.items():
        if oid not in permitted_ids:
            continue
        for event in events:
            if (
                event.action == "reject"
                and event.actor_id
                and within(event.occurred_at, start, end)
                and (allowed_actors is None or event.actor_id in allowed_actors)
            ):
                rejections[event.actor_id].append(event)
                by_person.setdefault(event.actor_id, [])
            if event.action == "adjudicate_refusal":
                ref = as_uuid(event.details.get("rejection_event_id"))
                if ref and isinstance(event.details.get("justified"), bool):
                    previous = judgments.get(ref)
                    if previous is None or (event.occurred_at, event.sequence) > (
                        previous.occurred_at,
                        previous.sequence,
                    ):
                        judgments[ref] = event

    issues: dict[tuple[UUID, UUID | None], list[datetime]] = defaultdict(list)
    for item in snapshot.orders:
        if item.work_type.value == "unplanned":
            issues[(item.equipment_id, item.fault_code_id)].append(item.issued_at)
    for times in issues.values():
        times.sort()
    grades_by_order = {item.id: latest_score(item, snapshot) for item in closed}

    def has_repeat(item: WorkOrder) -> bool:
        if item.completed_at is None or item.fault_code_id is None:
            return False
        times = issues[(item.equipment_id, item.fault_code_id)]
        index = bisect_right(times, item.completed_at)
        return index < len(times) and times[index] <= min(
            item.completed_at + timedelta(days=7), now
        )

    def one(identifier: UUID, name: str, rows: list[WorkOrder], actors: set[UUID]) -> RatingView:
        n = len(rows)
        grades = [score for o in rows if (score := grades_by_order[o.id]) is not None]
        complete = [o for o in rows if o.completed_at is not None]
        timely = sum(o.completed_at is not None and o.completed_at <= o.deadline for o in complete)
        mature = [o for o in rows if o.completed_at and o.completed_at + timedelta(days=7) <= now]
        bad = sum(
            was_reworked(o, snapshot.events.get(o.id, []), o.closed_at or now) or has_repeat(o)
            for o in mature
        )
        known_norms = [
            snapshot.norms[(o.fault_code_id, snapshot.equipment[o.equipment_id].equipment_type)]
            for o in rows
            if o.fault_code_id is not None
            and (o.fault_code_id, snapshot.equipment[o.equipment_id].equipment_type)
            in snapshot.norms
        ]
        rejects = [e for actor in actors for e in rejections.get(actor, [])]
        judged = [judgments[e.id] for e in rejects if e.id in judgments]
        unjustified = sum(e.details["justified"] is False for e in judged)
        parts = {
            "quality": component(
                sum(grades) / (5 * len(grades)) if grades else None,
                sum(grades),
                5 * len(grades),
                f"Сумма итоговых оценок / (5 × оценённых). Оценка мастера приоритетна; "
                f"оценено {len(grades)} из {n}.",
            ),
            "timeliness": component(
                timely / len(complete) if complete else None,
                timely,
                len(complete),
                "Сдача не позже срока / закрытые наряды с датой сдачи. Время приёмки "
                "мастером не штрафуется.",
            ),
            "rework": component(
                1 - bad / len(mature) if mature else None,
                bad,
                len(mature),
                f"1 − доля доработок или повторных отказов за 7 дней. Полное окно у "
                f"{len(mature)} из {n}; причина не доказана.",
            ),
            "volume": component(
                min(sum(known_norms) / 1200, 1) if known_norms else None,
                sum(known_norms),
                1200,
                f"min(сумма нормоминут / 1200, 1): шкала до 20 нормочасов за период, не "
                f"загрузка смены. Норматив у {len(known_norms)} из {n}.",
            ),
            "refusal": component(
                1 - unjustified / len(judged) if judged else None,
                unjustified,
                len(judged),
                f"1 − доля необоснованных среди рассмотренных отказов. Рассмотрено "
                f"{len(judged)} из {len(rejects)}; остальные не штрафуются.",
            ),
        }
        available = [key for key, value in parts.items() if value.value is not None]
        rating_score = (
            (
                sum(WEIGHTS[key] * (parts[key].value or 0) for key in available)
                / sum(WEIGHTS[key] for key in available)
                * 100
            )
            if available and n
            else None
        )
        return RatingView(
            subject_id=identifier,
            subject_name=name,
            score=round(rating_score, 2) if rating_score is not None else None,
            sample_size=n,
            components=parts,
            unavailable_components=[key for key in WEIGHTS if key not in available],
        )

    people = [
        one(pid, snapshot.employees[pid].display_name, rows, {pid})
        for pid, rows in by_person.items()
        if pid in snapshot.employees and (allowed_actors is None or pid in allowed_actors)
    ]
    grouped: dict[UUID, list[WorkOrder]] = defaultdict(list)
    brigade_actors: dict[UUID, set[UUID]] = defaultdict(set)
    for person in people:
        brigade = snapshot.employees[person.subject_id].brigade_id
        if brigade:
            grouped[brigade].extend(by_person[person.subject_id])
            brigade_actors[brigade].add(person.subject_id)
    brigades = [
        one(bid, snapshot.brigades[bid].name, rows, brigade_actors[bid])
        for bid, rows in grouped.items()
        if bid in snapshot.brigades
    ]

    def ranking(row: RatingView) -> tuple[float, int, str]:
        return (-(row.score if row.score is not None else -1), -row.sample_size, row.subject_name)

    return RatingsView(
        employees=sorted(people, key=ranking),
        brigades=sorted(brigades, key=ranking),
        limitations=[
            "Веса: качество 40%, сроки 25%, без доработок/повторов 20%, объём 10%, отказы "
            "5%. Доступные веса перенормируются.",
            "Менее 5 закрытых нарядов — малая выборка: рейтинг предварительный; недавние "
            "ремонты исключены из семидневного компонента.",
            "Бригада и нормативы взяты из текущих справочников; их исторические изменения "
            "не сохраняются.",
            "Повторная неисправность — сигнал для разбора, не доказательство вины исполнителя.",
        ],
    )
