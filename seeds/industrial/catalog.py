# ruff: noqa: RUF001
"""Reference catalog for the removable industrial fixture package."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID

Id = Callable[[str, str], UUID]


AREAS = (
    ("CRUSH", "Дробильный комплекс"),
    ("MINE", "Горный участок"),
    ("HAUL", "Карьерный транспорт"),
    ("POWER", "Энергетическое хозяйство"),
)
BRIGADES = (
    ("BR-01", "Механическая бригада"),
    ("BR-02", "Электроремонтная бригада"),
    ("BR-03", "Сервисная бригада"),
)
EQUIPMENT_SPECS = (
    ("CRUSH", "conveyor", "Конвейер", 7),
    ("CRUSH", "crusher", "Дробилка", 5),
    ("MINE", "excavator", "Экскаватор", 4),
    ("MINE", "pump", "Водоотливной насос", 3),
    ("HAUL", "truck", "Карьерный самосвал", 4),
    ("POWER", "pump", "Насос охлаждения", 2),
)
FAULTS = (
    ("MECH-001", "Износ ролика", "механик", ("conveyor",)),
    ("MECH-002", "Смещение ленты", "механик", ("conveyor",)),
    ("MECH-003", "Люфт подшипника", "механик", ("conveyor", "crusher", "truck")),
    ("MECH-004", "Ослабление крепежа", "механик", ("conveyor", "crusher", "excavator", "truck")),
    ("MECH-005", "Шум редуктора", "механик", ("conveyor", "crusher")),
    ("ELEC-001", "Перегрев электродвигателя", "электрик", ("conveyor", "crusher", "pump")),
    ("ELEC-002", "Повреждение кабеля", "электрик", ("conveyor", "pump")),
    ("ELEC-003", "Сбой датчика", "электрик", ("conveyor", "crusher", "truck")),
    ("ELEC-004", "Неисправность пускателя", "электрик", ("conveyor", "pump")),
    ("ELEC-005", "Отклонение напряжения", "электрик", ("crusher", "pump")),
    ("HYD-001", "Утечка масла", "гидравлик", ("excavator", "truck")),
    ("HYD-002", "Падение давления", "гидравлик", ("excavator", "truck", "pump")),
    ("HYD-003", "Износ рукава", "гидравлик", ("excavator", "truck")),
    ("HYD-004", "Засорение фильтра", "гидравлик", ("excavator", "pump")),
    ("HYD-005", "Перегрев гидросистемы", "гидравлик", ("excavator", "truck")),
    ("GEN-001", "Очистка узла", "универсал", ("conveyor", "crusher", "pump")),
    (
        "GEN-002",
        "Плановый осмотр",
        "универсал",
        ("conveyor", "crusher", "excavator", "truck", "pump"),
    ),
    ("GEN-003", "Регулировка привода", "универсал", ("conveyor", "crusher", "pump")),
    ("GEN-004", "Замена смазки", "универсал", ("conveyor", "crusher", "excavator", "truck")),
    ("GEN-005", "Проверка ограждения", "универсал", ("conveyor", "crusher")),
)
MATERIAL_KINDS = (
    ("крепёж М16", "шт"),
    ("подшипник", "шт"),
    ("ролик конвейерный", "шт"),
    ("лента конвейерная", "м"),
    ("смазка редукторная", "кг"),
    ("масло гидравлическое", "л"),
    ("рукав высокого давления", "м"),
    ("фильтр гидравлический", "шт"),
    ("кабель силовой", "м"),
    ("контактор", "шт"),
)
# Four stock variants per material family; specifications are illustrative.
MATERIAL_VARIANTS = (
    ("Крепёж: болт М16×50", "Крепёж: болт М20×60", "Крепёж: гайка М16", "Крепёж: шайба 20"),
    ("Подшипник 6206-2RS", "Подшипник 6310", "Подшипник 22212", "Подшипник NU308"),
    (
        "Ролик конвейерный 108×380",
        "Ролик конвейерный 108×465",
        "Ролик конвейерный 133×530",
        "Ролик конвейерный 159×600",
    ),
    (
        "Лента конвейерная 800 мм",
        "Лента конвейерная 1000 мм",
        "Лента конвейерная 1200 мм",
        "Лента конвейерная 650 мм",
    ),
    (
        "Смазка литиевая EP2",
        "Смазка редукторная EP00",
        "Смазка подшипниковая EP3",
        "Смазка универсальная EP1",
    ),
    (
        "Масло гидравлическое HLP46",
        "Масло гидравлическое HVLP32",
        "Масло гидравлическое HLP68",
        "Масло гидравлическое HVLP46",
    ),
    (
        "Рукав высокого давления DN10",
        "Рукав высокого давления DN12",
        "Рукав высокого давления DN16",
        "Рукав высокого давления DN20",
    ),
    (
        "Фильтр гидравлический 10 мкм",
        "Фильтр гидравлический 25 мкм",
        "Фильтр гидравлический 40 мкм",
        "Фильтр гидравлический 60 мкм",
    ),
    (
        "Кабель силовой 4×2,5 мм²",
        "Кабель силовой 4×4 мм²",
        "Кабель силовой 4×6 мм²",
        "Кабель силовой 4×10 мм²",
    ),
    (
        "Контактор 25 А, катушка 220 В",
        "Контактор 40 А, катушка 220 В",
        "Контактор 63 А, катушка 220 В",
        "Контактор 80 А, катушка 220 В",
    ),
)

PEOPLE = (
    ("master.sadykov", "Руслан Садыков", "master", "мастер ремонта", 6, None),
    ("master.orlova", "Елена Орлова", "master", "мастер ремонта", 6, None),
    ("exec.amanov", "Айдар Аманов", "executor", "механик", 5, "BR-01"),
    ("exec.bekova", "Сауле Бекова", "executor", "электрик", 5, "BR-02"),
    ("exec.chernov", "Павел Чернов", "executor", "гидравлик", 4, "BR-03"),
    ("exec.daulet", "Данияр Дәулет", "executor", "универсал", 4, "BR-01"),
    ("exec.ermak", "Илья Ермаков", "executor", "механик", 4, "BR-01"),
    ("exec.farida", "Фарида Нурова", "executor", "электрик", 4, "BR-02"),
    ("exec.gromov", "Олег Громов", "executor", "гидравлик", 5, "BR-03"),
    ("exec.halik", "Марат Халиков", "executor", "универсал", 3, "BR-03"),
    ("exec.iskakov", "Серик Искаков", "executor", "механик", 5, "BR-01"),
    ("exec.junus", "Юнус Камалов", "executor", "электрик", 3, "BR-02"),
    ("exec.kim", "Виктор Ким", "executor", "гидравлик", 4, "BR-03"),
    ("exec.larina", "Анна Ларина", "executor", "универсал", 4, "BR-03"),
    ("exec.mukan", "Ерлан Муканов", "executor", "механик", 3, "BR-01"),
    ("exec.nazar", "Тимур Назаров", "executor", "электрик", 4, "BR-02"),
    ("exec.osen", "Никита Осенин", "executor", "гидравлик", 3, "BR-03"),
    ("manager.tulegen", "Арман Тулегенов", "manager", "руководитель участка", 6, None),
    ("admin.karim", "Лейла Каримова", "admin", "администратор", 5, None),
)


def build_catalog(ident: Id) -> dict[str, list[dict[str, Any]]]:
    areas = [{"id": ident("area", code), "code": code, "name": name} for code, name in AREAS]
    area_ids = {row["code"]: row["id"] for row in areas}
    brigades = [
        {"id": ident("brigade", code), "code": code, "name": name} for code, name in BRIGADES
    ]
    brigade_ids = {row["code"]: row["id"] for row in brigades}
    equipment: list[dict[str, Any]] = []
    serial = 1
    for area_code, kind, title, count in EQUIPMENT_SPECS:
        for local in range(1, count + 1):
            number = f"{area_code[:2]}-{serial:03d}"
            equipment.append(
                {
                    "id": ident("equipment", number),
                    "inventory_number": number,
                    "name": f"{title} {local}",
                    "area_id": area_ids[area_code],
                    "equipment_type": kind,
                    "criticality": 1 + (serial * 3) % 5,
                }
            )
            serial += 1
    faults = [
        {"id": ident("fault", code), "code": code, "name": name, "specialty": specialty}
        for code, name, specialty, _ in FAULTS
    ]
    materials = [
        {
            "id": ident("material", f"MAT-{i:03d}"),
            "code": f"MAT-{i:03d}",
            "name": MATERIAL_VARIANTS[(i - 1) % 10][(i - 1) // 10],
            "unit": unit,
        }
        for i in range(1, 41)
        for _kind, unit in (MATERIAL_KINDS[(i - 1) % len(MATERIAL_KINDS)],)
    ]
    employees = [
        {
            "id": ident("employee", login),
            "login": login,
            "display_name": name,
            "role": role,
            "specialty": specialty,
            "grade": grade,
            "brigade_id": brigade_ids.get(brigade),
            "is_active": True,
            "is_on_shift": True,
        }
        for login, name, role, specialty, grade, brigade in PEOPLE
    ]
    employee_areas = [
        {"employee_id": person["id"], "area_id": area["id"]}
        for person in employees
        if person["role"] in {"master", "executor", "manager"}
        for area in areas
    ]
    time_norms = [
        {
            "id": ident("norm", f"{fault['code']}:{kind}"),
            "fault_code_id": fault["id"],
            "equipment_type": kind,
            "minutes": 40 + ((index * 13 + len(kind) * 7) % 160),
        }
        for index, fault in enumerate(faults)
        for kind in fault_types(fault["code"])
    ]
    return {
        "areas": areas,
        "brigades": brigades,
        "equipment": equipment,
        "employees": employees,
        "employee_areas": employee_areas,
        "fault_codes": faults,
        "materials": materials,
        "time_norms": time_norms,
    }


def fault_types(code: str) -> tuple[str, ...]:
    return next(types for fault, _, _, types in FAULTS if fault == code)
