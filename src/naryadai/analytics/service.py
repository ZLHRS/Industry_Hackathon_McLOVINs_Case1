"""Scoped, bounded analytics with one PostgreSQL snapshot and event-time metrics."""

# ruff: noqa: RUF001
from datetime import UTC, datetime, timedelta
from uuid import UUID

from anyio import to_thread
from sqlalchemy import select, text

from naryadai.application.common import OperationError
from naryadai.auth.dependencies import Principal
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    Area,
    Brigade,
    Employee,
    EmployeeArea,
    Equipment,
    WorkOrder,
)

from . import aggregates
from .contracts import (
    AnalyticsOptions,
    AnalyticsQuery,
    AnalyticsReport,
    DowntimeEquipmentView,
    FilterView,
    LeadersView,
    LeaderView,
    MetaView,
    NamedValue,
    OrdersView,
    PeriodView,
    ScopeView,
)
from .data import Snapshot, load_snapshot
from .history import NOT_OVERDUE, TERMINAL, status_at, within
from .insights import anomalies
from .periods import resolve_period
from .ratings import build_ratings


def _scope(principal: Principal, query: AnalyticsQuery) -> tuple[UUID, ...]:
    if principal.role not in {"master", "manager", "executor"}:
        raise OperationError(403, "analytics_role_not_permitted")
    areas = set(principal.area_ids)
    if query.area_ids and not set(query.area_ids) <= areas:
        raise OperationError(404, "analytics_area_not_found")
    if principal.role == "executor":
        if query.executor_ids and set(query.executor_ids) != {principal.employee_id}:
            raise OperationError(403, "executor_own_report_only")
        if query.brigade_ids:
            raise OperationError(403, "executor_own_report_only")
    return tuple(sorted(set(query.area_ids) or areas, key=str))


async def build_report(
    database: Database, principal: Principal, query: AnalyticsQuery, *, now: datetime | None = None
) -> AnalyticsReport:
    moment = now or datetime.now(UTC)
    period = resolve_period(query)
    scope = _scope(principal, query)
    data = await load_snapshot(
        database, scope, query.equipment_ids, min(period.to + timedelta(days=7), moment), moment
    )
    # All numeric work runs off the event loop; there is no DB transaction/network IO here.
    return await to_thread.run_sync(_calculate, data, principal, query, period, scope, moment)


def _calculate(
    data: Snapshot,
    principal: Principal,
    query: AnalyticsQuery,
    period: PeriodView,
    scope: tuple[UUID, ...],
    now: datetime,
) -> AnalyticsReport:
    start, end = period.from_, min(period.to, now)
    actors = set(query.executor_ids)
    if query.brigade_ids:
        brigade_people = {
            p.id for p in data.employees.values() if p.brigade_id in query.brigade_ids
        }
        actors = actors & brigade_people if actors else brigade_people
    if principal.role == "executor":
        actors = {principal.employee_id}
    filter_people = bool(query.executor_ids or query.brigade_ids or principal.role == "executor")
    selected: list[WorkOrder] = []
    for order in data.orders:
        events = data.events.get(order.id, [])
        if (
            filter_people
            and order.executor_id not in actors
            and not any(event.actor_id in actors and event.action == "complete" for event in events)
        ):
            continue
        if order.issued_at >= end or end <= start:
            continue
        interval = aggregates.recorded_interval(order, data, now)
        touches = any(
            within(t, start, end) for t in (order.issued_at, order.completed_at, order.closed_at)
        )
        event_touch = any(
            within(e.occurred_at, start, end)
            and e.action not in {"record_downtime", "adjudicate_refusal"}
            for e in events
        )
        open_at_start = order.issued_at < start and status_at(order, events, start) not in TERMINAL
        downtime_touch = bool(interval and interval[0] < end and interval[1] > start)
        if touches or event_touch or open_at_start or downtime_touch:
            selected.append(order)
    completed_ids = {
        o.id
        for o in selected
        if within(o.completed_at, start, end)
        or any(
            e.action == "complete" and within(e.occurred_at, start, end)
            for e in data.events.get(o.id, [])
        )
    }
    rejected_ids = {
        o.id
        for o in selected
        if any(
            e.action == "reject" and within(e.occurred_at, start, end)
            for e in data.events.get(o.id, [])
        )
    }
    overdue_ids = {
        o.id
        for o in selected
        if o.deadline < end and status_at(o, data.events.get(o.id, []), end) not in NOT_OVERDUE
    }
    backlog = sum(status_at(o, data.events.get(o.id, []), end) not in TERMINAL for o in selected)
    ratings = build_ratings(selected, data, start, end, now, actors if filter_people else None)
    active = aggregates.activity(selected, data, start, end)
    material = aggregates.materials(selected, data, start, end)
    if principal.role == "executor":
        ratings.brigades = []
        active.by_employee = [
            r for r in active.by_employee if r.employee_id == principal.employee_id
        ]
        active.active_seconds = sum(r.active_seconds for r in active.by_employee)
        active.active_order_count = sum(r.order_count for r in active.by_employee)
        material.by_executor = [
            r for r in material.by_executor if r.dimension_id == principal.employee_id
        ]
    stopped = aggregates.downtime(selected, data, start, end, now)
    leader_rows = _leaders(selected, data, stopped.by_equipment, overdue_ids, start, end)
    warnings = [
        "Выдано/сдано/закрыто/отказы — уникальные наряды по событиям периода. Остаток и "
        "просрочка — на его наблюдаемый конец.",
        "Фильтры исполнителя/бригады отбирают наряды по текущему назначению. Справочники "
        "не хранят историю состава бригад.",
        "Повторы и ППР проверяются с контекстом доступного оборудования вне границ периода "
        "и фильтра исполнителя.",
        "Нет записи простоя — нет доказательства остановки. При пересечении планового и "
        "внепланового интервалов приоритет у внепланового.",
        "Несколько одновременных причин простоя выделены отдельно, чтобы не удваивать время.",
    ]
    if any(
        u.submission_version is None
        for u, _ in data.usages
        if u.work_order_id in {o.id for o in selected}
    ):
        warnings.append(
            "У старых списаний без версии сдачи дата определена по полю выполнения наряда; "
            "отдельной даты списания нет."
        )
    if end <= start:
        warnings.append("Выбранный период ещё не наблюдался: будущие результаты не прогнозируются.")
    return AnalyticsReport(
        period=period,
        filters=FilterView(
            area_ids=list(query.area_ids),
            equipment_ids=list(query.equipment_ids),
            executor_ids=list(query.executor_ids),
            brigade_ids=list(query.brigade_ids),
        ),
        scope=ScopeView(role=principal.role, area_ids=list(scope)),
        orders=OrdersView(
            issued=sum(within(o.issued_at, start, end) for o in selected),
            completed=len(completed_ids),
            closed=sum(within(o.closed_at, start, end) for o in selected),
            overdue=len(overdue_ids),
            rejected=len(rejected_ids),
            backlog=backlog,
        ),
        durations=aggregates.durations(selected, data, start, end),
        activity=active,
        downtime=stopped,
        ratings=ratings,
        materials=material,
        leaders=LeadersView() if principal.role == "executor" else leader_rows,
        anomalies=[]
        if principal.role == "executor"
        else anomalies(selected, data, start, end, now),
        meta=MetaView(
            as_of=now,
            row_count=len(selected),
            synthetic_count=sum(o.is_synthetic for o in selected),
            warnings=warnings,
            formula_descriptions={
                "Рейтинг": "40% качество +25% сроки +20% отсутствие повторов/доработок "
                "+10% нормированный объём +5% обоснованность отказов. Недоступные веса "
                "перенормируются.",
                "Время реакции": "Среднее от выдачи до первого принятия, очереди или "
                "отказа; событие реакции попало в период.",
                "Время работы": "Средняя сумма интервалов в работе по каждой сдаче в "
                "периоде. Паузы считаются отдельно.",
                "Загрузка": "Объединение интервалов работы по исполнителю в выбранном "
                "периоде; графика смен для процента загрузки нет.",
                "Простои": "Зарегистрированные интервалы, обрезанные периодом, объединены "
                "по машине. Исправления учитываются на дату отчёта.",
            },
        ),
    )


def _leaders(
    orders: list[WorkOrder],
    data: Snapshot,
    downtime_rows: list[DowntimeEquipmentView],
    overdue: set[UUID],
    start: datetime,
    end: datetime,
) -> LeadersView:
    problem = [
        o for o in orders if o.work_type.value == "unplanned" and within(o.issued_at, start, end)
    ]
    machines: list[LeaderView] = []
    areas: list[LeaderView] = []
    downtime_by_machine = {row.equipment_id: row.known_seconds for row in downtime_rows}
    for eid in {o.equipment_id for o in problem}:
        rows = [o for o in problem if o.equipment_id == eid]
        machines.append(
            LeaderView(
                id=eid,
                name=data.equipment[eid].name,
                order_count=len(rows),
                overdue_count=sum(o.id in overdue for o in rows),
                downtime_seconds=downtime_by_machine.get(eid, 0),
            )
        )
    for aid in {o.area_id for o in problem}:
        rows = [o for o in problem if o.area_id == aid]
        seconds = sum(
            value
            for eid, value in downtime_by_machine.items()
            if data.equipment[eid].area_id == aid
        )
        areas.append(
            LeaderView(
                id=aid,
                name=data.areas[aid].name,
                order_count=len(rows),
                overdue_count=sum(o.id in overdue for o in rows),
                downtime_seconds=seconds,
            )
        )
    return LeadersView(
        machines=sorted(machines, key=lambda r: (-r.order_count, r.name))[:10],
        areas=sorted(areas, key=lambda r: (-r.order_count, r.name))[:10],
    )


async def analytics_options(database: Database, principal: Principal) -> AnalyticsOptions:
    scope = _scope(principal, AnalyticsQuery(date=datetime.now(UTC).date()))
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        areas = list(
            await session.scalars(select(Area).where(Area.id.in_(scope)).order_by(Area.name))
        )
        equipment = list(
            await session.scalars(
                select(Equipment).where(Equipment.area_id.in_(scope)).order_by(Equipment.name)
            )
        )
        query = (
            select(Employee)
            .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
            .where(EmployeeArea.area_id.in_(scope), Employee.role == "executor")
            .distinct()
            .order_by(Employee.display_name)
        )
        if principal.role == "executor":
            query = query.where(Employee.id == principal.employee_id)
        people = list(await session.scalars(query))
        brigades = (
            []
            if principal.role == "executor"
            else list(
                await session.scalars(
                    select(Brigade)
                    .where(Brigade.id.in_({p.brigade_id for p in people if p.brigade_id}))
                    .order_by(Brigade.name)
                )
            )
        )
    return AnalyticsOptions(
        areas=[NamedValue(id=a.id, name=a.name, code=a.code) for a in areas],
        equipment=[NamedValue(id=e.id, name=e.name, code=e.inventory_number) for e in equipment],
        executors=[NamedValue(id=p.id, name=p.display_name) for p in people],
        brigades=[NamedValue(id=b.id, name=b.name, code=b.code) for b in brigades],
    )
