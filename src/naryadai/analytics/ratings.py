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
    return any(e.occurred_at <= cutoff and e.to_status.value == "rework" for e in events)


def _details(event: WorkOrderEvent) -> dict[str, object]:
    details = getattr(event, "details", {})
    return details if isinstance(details, dict) else {}


def _submission_version(event: WorkOrderEvent) -> int | None:
    value = _details(event).get("submission_version", getattr(event, "order_version", None))
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _completion_actor(
    events: list[WorkOrderEvent], *, submission_version: int | None, cutoff: datetime
) -> UUID | None:
    completed = [
        event
        for event in events
        if getattr(event, "action", None) == "complete"
        and event.occurred_at <= cutoff
        and event.actor_id is not None
    ]
    if submission_version is not None:
        completed = [
            event for event in completed if _submission_version(event) == submission_version
        ]
    if len(completed) == 1:
        return completed[0].actor_id
    if len(completed) > 1:
        latest = max(completed, key=lambda event: (event.occurred_at, event.sequence))
        return latest.actor_id
    return None


def _has_reassignment(events: list[WorkOrderEvent], cutoff: datetime) -> bool:
    return any(
        getattr(event, "action", None) == "reassign" and event.occurred_at <= cutoff
        for event in events
    )


def final_submission_actor(order: WorkOrder, snapshot: Snapshot) -> UUID | None:
    """Return the executor who submitted the work that was actually closed.

    A reassignment makes ``work_orders.executor_id`` historicaly ambiguous.  In
    that case attribution requires a matching completion event.  Legacy rows
    without a reassignment retain their stable executor attribution.
    """

    cutoff = getattr(order, "closed_at", None) or order.completed_at
    if cutoff is None:
        return None
    events = snapshot.events.get(order.id, [])
    closure = next(
        (
            event
            for event in reversed(events)
            if getattr(event, "action", None) in {"close", "override_close"}
            and event.occurred_at <= cutoff
        ),
        None,
    )
    submission_version = _submission_version(closure) if closure is not None else None
    if closure is not None and submission_version is None:
        review_id = as_uuid(_details(closure).get("review_id"))
        if review_id is not None:
            review = next((item for item in snapshot.reviews if item.id == review_id), None)
            submission_version = None if review is None else review.order_version
    if submission_version is None:
        submission_version = getattr(order, "last_submission_version", None)
    actor = _completion_actor(events, submission_version=submission_version, cutoff=cutoff)
    if actor is not None:
        return actor
    return None if _has_reassignment(events, cutoff) else order.executor_id


def rework_actors(order: WorkOrder, events: list[WorkOrderEvent], cutoff: datetime) -> set[UUID]:
    """Attribute rework to the submitted attempt, never a later reassignee."""

    result: set[UUID] = set()
    reassigned = _has_reassignment(events, cutoff)
    for event in events:
        if event.occurred_at > cutoff or event.to_status.value != "rework":
            continue
        actor = _completion_actor(
            events, submission_version=_submission_version(event), cutoff=event.occurred_at
        )
        if actor is None:
            actor = _completion_actor(events, submission_version=None, cutoff=event.occurred_at)
        if actor is not None:
            result.add(actor)
        elif not reassigned:
            result.add(order.executor_id)
    return result


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
    rework_rows: dict[UUID, dict[UUID, tuple[WorkOrder, bool]]] = defaultdict(dict)
    missing_closed_attribution = 0
    missing_rework_history = 0
    for order in closed:
        actor = final_submission_actor(order, snapshot)
        events = snapshot.events.get(order.id, [])
        if not events and order.attempt > 1:
            missing_rework_history += 1
        reworked = rework_actors(order, events, order.closed_at or now)
        if actor is None:
            missing_closed_attribution += 1
        else:
            by_person[actor].append(order)
            if events or order.attempt == 1:
                rework_rows[actor][order.id] = (order, actor in reworked)
        for rework_actor in reworked:
            # A returned attempt belongs to its submitting executor even when another
            # executor later closes the same order after reassignment.
            rework_rows[rework_actor][order.id] = (order, True)
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

    def one(
        identifier: UUID,
        name: str,
        rows: list[WorkOrder],
        actors: set[UUID],
        attributed_rework: list[tuple[WorkOrder, bool]],
    ) -> RatingView:
        closed_count = len(rows)
        n = max(closed_count, len(attributed_rework))
        grades = [score for o in rows if (score := grades_by_order[o.id]) is not None]
        complete = [o for o in rows if o.completed_at is not None]
        timely = sum(o.completed_at is not None and o.completed_at <= o.deadline for o in complete)
        mature = [
            (order, reworked)
            for order, reworked in attributed_rework
            if order.completed_at and order.completed_at + timedelta(days=7) <= now
        ]
        bad = sum(reworked or has_repeat(order) for order, reworked in mature)
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
                f"оценено {len(grades)} из {closed_count} закрытых сдач.",
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
                f"1 − доля доработок или повторных отказов за 7 дней среди уникальных "
                f"закрытых нарядов с известной сдачей исполнителя. Сдача до переназначения "
                "относится к её автору. "
                f"Полное окно у {len(mature)} из {len(attributed_rework)}; причина не доказана.",
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

    people = []
    for person_id in sorted(set(by_person) | set(rework_rows), key=str):
        if person_id not in snapshot.employees or (
            allowed_actors is not None and person_id not in allowed_actors
        ):
            continue
        people.append(
            one(
                person_id,
                snapshot.employees[person_id].display_name,
                by_person[person_id],
                {person_id},
                list(rework_rows[person_id].values()),
            )
        )
    grouped: dict[UUID, list[WorkOrder]] = defaultdict(list)
    brigade_actors: dict[UUID, set[UUID]] = defaultdict(set)
    brigade_rework_rows: dict[UUID, list[tuple[WorkOrder, bool]]] = defaultdict(list)
    for person in people:
        brigade = snapshot.employees[person.subject_id].brigade_id
        if brigade:
            grouped[brigade].extend(by_person[person.subject_id])
            brigade_actors[brigade].add(person.subject_id)
            brigade_rework_rows[brigade].extend(rework_rows[person.subject_id].values())
    brigades = [
        one(
            bid,
            snapshot.brigades[bid].name,
            rows,
            brigade_actors[bid],
            brigade_rework_rows[bid],
        )
        for bid, rows in grouped.items()
        if bid in snapshot.brigades
    ]

    def ranking(row: RatingView) -> tuple[float, int, str]:
        return (-(row.score if row.score is not None else -1), -row.sample_size, row.subject_name)

    limitations = [
        "Веса: качество 40%, сроки 25%, без доработок/повторов 20%, объём 10%, отказы "
        "5%. Доступные веса перенормируются.",
        "Менее 5 закрытых нарядов — малая выборка: рейтинг предварительный; недавние "
        "ремонты исключены из семидневного компонента.",
        "Бригада и нормативы взяты из текущих справочников; их исторические изменения "
        "не сохраняются.",
        "Повторная неисправность — сигнал для разбора, не доказательство вины исполнителя.",
        "Знаменатель доработок — уникальные закрытые наряды с известной сдачей "
        "исполнителя; сдача до переназначения относится к её автору. Без истории сдачи "
        "персональная вина не предполагается.",
    ]
    if missing_closed_attribution:
        limitations.append(
            f"{missing_closed_attribution} закрытых нарядов без полной истории сдачи после "
            "переназначения исключены из персональной оценки: вина не предполагается."
        )
    if missing_rework_history:
        limitations.append(
            f"{missing_rework_history} закрытых нарядов имеют только счётчик попыток без "
            "истории доработки; они не влияют на персональный показатель доработок."
        )
    return RatingsView(
        employees=sorted(people, key=ranking),
        brigades=sorted(brigades, key=ranking),
        limitations=limitations,
    )
