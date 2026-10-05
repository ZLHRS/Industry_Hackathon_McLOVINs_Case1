"""Snapshot and export of a private work-order card and its repair evidence."""

# ruff: noqa: RUF001
import hashlib
from datetime import UTC, datetime
from io import BytesIO
from typing import Any
from uuid import UUID

from anyio import CapacityLimiter, to_thread
from PIL import Image
from sqlalchemy import select, text

from naryadai.application.common import OperationError, get_order
from naryadai.auth.dependencies import Principal
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    AIReview,
    Area,
    Employee,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    Photo,
    WorkOrderEvent,
)
from naryadai.infrastructure.photo_store import PhotoStore, PhotoStoreError
from naryadai.reporting.workbooks import ReportWorkbook

STATUS = {
    "issued": "Выдан",
    "accepted": "Принят",
    "queued": "В очереди",
    "in_progress": "В работе",
    "paused": "Приостановлен",
    "completed": "Выполнен",
    "ai_review": "Проверка ИИ",
    "rework": "Доработка",
    "rejected": "Отклонён",
    "closed": "Закрыт",
    "cancelled": "Отменён",
}
ACTION = {
    "issue": "Выдача",
    "accept": "Принятие",
    "queue": "Очередь",
    "start": "Начало",
    "pause": "Пауза",
    "resume": "Продолжение",
    "complete": "Сдача",
    "reject": "Отказ",
    "close": "Приёмка",
    "override_close": "Приёмка с обоснованием",
    "request_rework": "Возврат на доработку",
    "reassign": "Переназначение",
    "cancel": "Отмена",
    "comment": "Комментарий",
    "change_priority": "Приоритет",
    "ai_review": "ИИ-проверка",
    "ai_accepted": "Проверка пройдена",
    "ai_rework": "Замечания ИИ",
    "manual_review": "Ручная проверка",
    "record_downtime": "Запись простоя",
    "adjudicate_refusal": "Оценка причины отказа",
}


async def export_order(
    database: Database,
    principal: Principal,
    order_id: UUID,
    store: PhotoStore,
    limiter: CapacityLimiter,
) -> bytes:
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        order = await get_order(session, order_id, principal)
        equipment = await session.get(Equipment, order.equipment_id)
        area = await session.get(Area, order.area_id)
        executor = await session.get(Employee, order.executor_id)
        master = await session.get(Employee, order.master_id)
        fault = await session.get(FaultCode, order.fault_code_id) if order.fault_code_id else None
        materials = (
            await session.execute(
                select(MaterialUsage, Material)
                .join(Material, Material.id == MaterialUsage.material_id)
                .where(MaterialUsage.work_order_id == order.id)
                .order_by(MaterialUsage.id)
                .limit(1001)
            )
        ).all()
        events = list(
            await session.scalars(
                select(WorkOrderEvent)
                .where(WorkOrderEvent.work_order_id == order.id)
                .order_by(WorkOrderEvent.sequence)
                .limit(2001)
            )
        )
        reviews = list(
            await session.scalars(
                select(AIReview)
                .where(AIReview.work_order_id == order.id)
                .order_by(AIReview.created_at, AIReview.id)
                .limit(201)
            )
        )
        photos = list(
            await session.scalars(
                select(Photo)
                .where(Photo.work_order_id == order.id)
                .order_by(Photo.uploaded_at, Photo.id)
                .limit(41)
            )
        )
        if len(materials) > 1000 or len(events) > 2000 or len(reviews) > 200 or len(photos) > 40:
            raise OperationError(413, "order_export_too_large")
        if sum(photo.size_bytes for photo in photos) > 15 * 1024 * 1024:
            raise OperationError(413, "order_export_photos_too_large")
        people_ids = {event.actor_id for event in events if event.actor_id is not None}
        people = {
            p.id: p.display_name
            for p in await session.scalars(select(Employee).where(Employee.id.in_(people_ids)))
        }
        card: list[list[object]] = [
            ["Номер", order.number],
            ["Снимок сформирован (UTC)", datetime.now(UTC)],
            ["Версия", order.version],
            ["Синтетические демоданные", order.is_synthetic],
            ["Статус", STATUS.get(order.status.value, order.status.value)],
            ["Вид", "Плановый" if order.work_type.value == "planned" else "Внеплановый"],
            ["Участок", area.name if area else None],
            ["Оборудование", equipment.name if equipment else None],
            ["Исполнитель", executor.display_name if executor else None],
            ["Мастер", master.display_name if master else None],
            ["Задание", order.description],
            ["Выдан (UTC)", order.issued_at],
            ["Срок (UTC)", order.deadline],
            ["Начат (UTC)", order.started_at],
            ["Выполнен (UTC)", order.completed_at],
            ["Закрыт (UTC)", order.closed_at],
            ["Выполненные работы", order.work_description],
            ["Неисправность", fault.name if fault else None],
            ["Без материалов: причина", order.no_materials_reason],
            ["Комментарий", order.comment],
            ["Попытка ремонта", order.attempt],
        ]
        history: list[list[object]] = [
            [
                e.sequence,
                e.occurred_at,
                people.get(e.actor_id, "Неизвестный автор") if e.actor_id else "Система",
                ACTION.get(e.action, e.action),
                STATUS.get(e.to_status.value, e.to_status.value),
                e.reason,
                _details(e.details),
            ]
            for e in events
        ]
        lines = [[m.name, m.unit, u.quantity, u.submission_version] for u, m in materials]
        assessments = [
            [
                r.created_at,
                r.order_version,
                r.model_name,
                r.verdict.value if r.verdict else None,
                r.score,
                r.master_score,
                r.needs_master_review,
                r.explanation,
            ]
            for r in reviews
        ]
        checks = _review_details(reviews)
        photo_info = [
            (p.storage_key, p.kind.value, p.attempt, p.uploaded_at, p.captured_at, p.sha256)
            for p in photos
        ]
    # File reads and rendering are outside the database transaction and bounded in a worker thread.
    try:
        return await to_thread.run_sync(
            _render, card, history, lines, assessments, checks, photo_info, store, limiter=limiter
        )
    except PhotoStoreError as error:
        raise OperationError(409, "report_photo_unavailable") from error


def _details(details: dict[str, Any]) -> str:
    labels = {
        "started_at": "Начало простоя",
        "ended_at": "Окончание простоя",
        "void": "Аннулирован",
        "justified": "Отказ обоснован",
        "reason": "Основание",
        "comment": "Комментарий",
        "master_score": "Оценка мастера",
        "executor_id": "Новый исполнитель",
        "rejection_event_id": "Событие отказа",
    }
    return "; ".join(f"{label}: {details[key]}" for key, label in labels.items() if key in details)


def _review_details(reviews: list[AIReview]) -> list[list[object]]:
    rows: list[list[object]] = []
    labels = {
        "active_minutes": "В работе, мин",
        "paused_minutes": "Паузы, мин",
        "elapsed_minutes": "Общее время, мин",
        "norm_minutes": "Норматив, мин",
    }
    statuses = {
        "pass": "Пройдено",
        "warning": "Замечание",
        "fail": "Не пройдено",
        "unknown": "Недостаточно данных",
    }
    for review in reviews:
        report = review.report or {}
        timing = report.get("timing")
        if isinstance(timing, dict):
            for key, label in labels.items():
                rows.append([review.order_version, label, timing.get(key), "На момент проверки"])
        checks = report.get("checks")
        if isinstance(checks, list):
            for check in checks:
                if isinstance(check, dict):
                    status = str(check.get("status", "unknown"))
                    rows.append(
                        [
                            review.order_version,
                            check.get("title"),
                            statuses.get(status, status),
                            check.get("detail"),
                        ]
                    )
        limitations = report.get("limitations")
        if isinstance(limitations, list):
            for limitation in limitations:
                if isinstance(limitation, str):
                    rows.append([review.order_version, "Ограничение", None, limitation])
    return rows


def _render(
    card: list[list[object]],
    history: list[list[object]],
    lines: list[list[Any]],
    assessments: list[list[Any]],
    checks: list[list[object]],
    photos: list[tuple[Any, ...]],
    store: PhotoStore,
) -> bytes:
    book = ReportWorkbook("Карточка наряда · НарядAI")
    sheet = book.table("Наряд", ["Поле", "Значение"], card)
    sheet.set_column(1, 1, 85, book.text)
    sheet = book.table(
        "История",
        ["№", "Время UTC", "Автор", "Действие", "Статус", "Причина", "Дополнения"],
        history,
    )
    sheet.set_column(5, 6, 60, book.text)
    book.table("Материалы", ["Материал", "Единица", "Количество", "Версия сдачи"], lines)
    sheet = book.table(
        "Оценки",
        [
            "Время UTC",
            "Сдача",
            "Источник / модель",
            "Вердикт",
            "Балл ИИ",
            "Балл мастера",
            "Решает мастер",
            "Объяснение",
        ],
        assessments,
    )
    sheet.set_column(7, 7, 85, book.text)
    sheet = book.table(
        "Проверки ремонта",
        ["Версия сдачи", "Проверка / показатель", "Результат", "Обоснование"],
        checks,
    )
    sheet.set_column(1, 1, 40, book.text)
    sheet.set_column(3, 3, 85, book.text)
    sheet = book.table(
        "Фотографии",
        ["Изображение", "Этап", "Попытка", "Загрузка UTC", "Заявленная съёмка UTC", "SHA-256"],
        [],
    )
    sheet.set_column(0, 0, 48)
    for row, (key, kind, attempt, uploaded, captured, digest) in enumerate(photos, 1):
        raw = store.read(key)
        if hashlib.sha256(raw).hexdigest() != digest:
            raise PhotoStoreError("photo_integrity_mismatch")
        with Image.open(BytesIO(raw)) as picture:
            width, height = picture.size
        scale = min(320 / width, 200 / height)
        sheet.set_row(row, 160)
        sheet.insert_image(
            row,
            0,
            "evidence.jpg",
            {"image_data": BytesIO(raw), "x_scale": scale, "y_scale": scale, "object_position": 1},
        )
        for col, value in enumerate(
            [
                "До" if kind == "before" else "После",
                str(attempt),
                uploaded.isoformat(),
                captured.isoformat() if captured else "Нет данных",
                digest,
            ],
            1,
        ):
            sheet.write_string(row, col, value, book.text)
    if not photos:
        sheet.write_string(1, 0, "Фотографии не приложены", book.text)
    book.table(
        "Пояснения",
        ["Условие"],
        [
            ["Снимок доступного наряда; все даты указаны в UTC."],
            ["Длительность ремонта не является доказанным простоем оборудования."],
            ["Материалы включают все сдачи. Дата съёмки заявлена клиентом; свежесть не доказана."],
            ["Исторические демооценки синтетические. Итоговое решение принимает мастер."],
        ],
    )
    return book.finish()
