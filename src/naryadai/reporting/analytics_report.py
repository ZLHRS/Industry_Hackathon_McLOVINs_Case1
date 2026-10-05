"""Human-readable report workbook from the exact authorized analytics response."""

# ruff: noqa: RUF001
from zoneinfo import ZoneInfo

from naryadai.analytics.contracts import AnalyticsReport
from naryadai.reporting.workbooks import ReportWorkbook

COMPONENTS = {
    "quality": "Качество",
    "timeliness": "В срок",
    "rework": "Без повторов и доработок",
    "volume": "Объём и сложность",
    "refusal": "Обоснованность отказов",
}


def export_analytics(report: AnalyticsReport) -> bytes:
    book = ReportWorkbook("Аналитика · НарядAI")
    period = report.period
    sheet = book.table(
        "Сводка",
        ["Показатель", "Значение"],
        [
            ["Период", period.label],
            ["Часовой пояс", period.timezone],
            ["Начало включительно", period.from_.astimezone(ZoneInfo(period.timezone)).isoformat()],
            [
                "Окончание исключительно",
                period.to.astimezone(ZoneInfo(period.timezone)).isoformat(),
            ],
            ["Сформирован (UTC)", report.meta.as_of.isoformat()],
            ["Выдано", report.orders.issued],
            ["Выполнено", report.orders.completed],
            ["Закрыто", report.orders.closed],
            ["Просрочено", report.orders.overdue],
            ["Отказы", report.orders.rejected],
            ["Незавершённые", report.orders.backlog],
            ["Среднее время реакции, мин", _minutes(report.durations.response_seconds)],
            ["Среднее время работы, мин", _minutes(report.durations.work_seconds)],
            ["Средняя пауза, мин", _minutes(report.durations.pause_seconds)],
            ["Активная работа за период, мин", _minutes(report.activity.active_seconds)],
            ["Зарегистрированный простой, мин", _minutes(report.downtime.known_seconds)],
            ["Наряды без данных о простое", report.downtime.unknown_order_count],
            ["Нарядов в расчёте", report.meta.row_count],
            ["Из них синтетических", report.meta.synthetic_count],
        ],
    )
    sheet.set_column(0, 0, 48, book.text)
    sheet.set_column(1, 1, 50, book.text)
    component_rows: list[list[object]] = []
    for name, ratings in (
        ("Исполнители", report.ratings.employees),
        ("Бригады", report.ratings.brigades),
    ):
        rows: list[list[object]] = []
        for rating in ratings:
            rows.append(
                [
                    rating.subject_name,
                    rating.score,
                    rating.sample_size,
                    ", ".join(COMPONENTS.get(c, c) for c in rating.unavailable_components) or "—",
                ]
            )
            for key, component in rating.components.items():
                component_rows.append(
                    [
                        name,
                        rating.subject_name,
                        COMPONENTS.get(key, key),
                        component.value,
                        component.numerator,
                        component.denominator,
                        component.detail,
                    ]
                )
        sheet = book.table(
            name, ["Участник", "Рейтинг, 0–100", "Закрытые наряды", "Недоступные компоненты"], rows
        )
        sheet.set_column(0, 0, 38, book.text)
        if rows:
            chart = book.book.add_chart({"type": "bar"})
            chart.add_series(
                {
                    "name": "Рейтинг",
                    "categories": [name, 1, 0, min(10, len(rows)), 0],
                    "values": [name, 1, 1, min(10, len(rows)), 1],
                    "fill": {"color": "#237565"},
                    "border": {"none": True},
                }
            )
            chart.set_title({"name": "Рейтинг по доступным компонентам"})
            chart.set_x_axis({"min": 0, "max": 100})
            chart.set_legend({"none": True})
            sheet.insert_chart("F2", chart)
    sheet = book.table(
        "Состав рейтинга",
        ["Группа", "Участник", "Компонент", "Значение", "Числитель", "Знаменатель", "Объяснение"],
        component_rows,
    )
    sheet.set_column(6, 6, 85, book.text)
    book.table(
        "Материалы",
        ["Материал", "Единица", "Количество", "Нарядов"],
        [[r.material_name, r.unit, r.quantity, r.order_count] for r in report.materials.usage],
    )
    for name, material_breakdown in (
        ("Материалы-участки", report.materials.by_area),
        ("Материалы-машины", report.materials.by_equipment),
        ("Материалы-люди", report.materials.by_executor),
    ):
        book.table(
            name,
            ["Группа", "Материал", "Единица", "Количество", "Нарядов"],
            [
                [r.dimension_name, r.material_name, r.unit, r.quantity, r.order_count]
                for r in material_breakdown
            ],
        )
    book.table(
        "Простои",
        ["Оборудование", "Известный простой, мин", "Наряды без данных", "Наряды-основания"],
        [
            [
                r.equipment_name,
                _minutes(r.known_seconds),
                r.unknown_order_count,
                ", ".join(map(str, r.order_ids)),
            ]
            for r in report.downtime.by_equipment
        ],
    )

    book.table(
        "Загрузка",
        ["Исполнитель", "В работе, мин", "Паузы, мин", "Нарядов"],
        [
            [r.employee_name, _minutes(r.active_seconds), _minutes(r.paused_seconds), r.order_count]
            for r in report.activity.by_employee
        ],
    )
    book.table(
        "Причины простоя",
        ["Причина", "Зарегистрировано, мин"],
        [[name, _minutes(seconds)] for name, seconds in report.downtime.by_fault.items()],
    )
    book.table(
        "Виды простоя",
        ["Вид", "Зарегистрировано, мин"],
        [
            ["Плановый", _minutes(report.downtime.planned_seconds)],
            ["Внеплановый", _minutes(report.downtime.unplanned_seconds)],
        ],
    )
    for name, leaders in (
        ("Проблемные машины", report.leaders.machines),
        ("Проблемные участки", report.leaders.areas),
    ):
        book.table(
            name,
            ["Объект", "Внеплановые наряды", "Просроченные", "Известный простой, мин"],
            [
                [r.name, r.order_count, r.overdue_count, _minutes(r.downtime_seconds)]
                for r in leaders
            ],
        )
    sheet = book.table(
        "Отклонения",
        ["Сигнал", "Уровень", "Правило", "Основания"],
        [
            [
                r.title,
                {"low": "Низкий", "medium": "Средний", "high": "Высокий"}[r.severity],
                r.formula,
                _evidence(r.evidence),
            ]
            for r in report.anomalies
        ],
    )
    sheet.set_column(0, 0, 60, book.text)
    sheet.set_column(2, 3, 75, book.text)
    explanations: list[list[object]] = [
        [
            "Границы",
            "Начало включается, окончание не включается; периоды заданы в указанном часовом поясе.",
        ],
        [
            "Оценка",
            "Итоговый балл не заменяет решение мастера. Малые выборки требуют отдельной проверки.",
        ],
        [
            "Простой",
            "Учитываются записи мастера с объединением пересечений. Без записей время неизвестно.",
        ],
        [
            "Материалы",
            "Разные материалы и единицы не суммируются. "
            "Статистическое отклонение не является нормой расхода.",
        ],
        ["Участки-фильтр", ", ".join(map(str, report.filters.area_ids)) or "Все доступные"],
        [
            "Оборудование-фильтр",
            ", ".join(map(str, report.filters.equipment_ids)) or "Все доступные",
        ],
        ["Исполнители-фильтр", ", ".join(map(str, report.filters.executor_ids)) or "Все доступные"],
        ["Бригады-фильтр", ", ".join(map(str, report.filters.brigade_ids)) or "Все доступные"],
    ]
    for key, value in report.meta.formula_descriptions.items():
        explanations.append([key, value])
    for warning in [*report.meta.warnings, *report.ratings.limitations]:
        explanations.append(["Ограничение", warning])
    sheet = book.table("Методика", ["Условие", "Описание"], explanations)
    sheet.set_column(0, 0, 32, book.text)
    sheet.set_column(1, 1, 100, book.text)
    return book.finish()


def _minutes(seconds: float | None) -> float | None:
    return None if seconds is None else round(seconds / 60, 3)


def _evidence(evidence: dict[str, object]) -> str:
    labels = {
        "count": "Количество",
        "denominator": "База сравнения",
        "order_ids": "Наряды",
        "equipment_id": "Оборудование",
        "fault_code": "Неисправность",
        "ratio": "Отношение",
        "median": "Медиана",
        "baseline_median": "Медиана сравнения",
        "fault_code_id": "Неисправность",
        "employee_id": "Исполнитель",
        "baseline_count": "Наблюдений в базе сравнения",
        "quantity": "Количество материала",
        "unit": "Единица",
    }
    return "; ".join(
        f"{labels.get(key, key)}: "
        f"{', '.join(map(str, value)) if isinstance(value, list) else value}"
        for key, value in evidence.items()
    )
