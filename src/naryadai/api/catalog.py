"""Typed reference-data API with explicit administrative writes and area scoping."""

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from anyio import to_thread
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.auth.dependencies import DatabaseDep, PrincipalDep, require_admin, require_area
from naryadai.auth.security import hash_secret
from naryadai.infrastructure.models import (
    Area,
    AuthSession,
    Brigade,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    Material,
    TimeNorm,
    WorkOrder,
)

router = APIRouter(prefix="/catalog", tags=["catalog"])


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class View(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID


class AreaInput(Input):
    code: str = Field(min_length=2, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=160)


class AreaView(AreaInput, View):
    pass


class BrigadeInput(AreaInput):
    pass


class BrigadeView(BrigadeInput, View):
    pass


class EquipmentInput(Input):
    inventory_number: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=160)
    area_id: UUID
    equipment_type: str = Field(min_length=1, max_length=64)
    criticality: int = Field(ge=1, le=5)


class EquipmentView(EquipmentInput, View):
    pass


class FaultInput(AreaInput):
    specialty: str = Field(min_length=1, max_length=64)


class FaultView(FaultInput, View):
    pass


class MaterialInput(AreaInput):
    unit: str = Field(min_length=1, max_length=24)


class MaterialView(MaterialInput, View):
    pass


class TimeNormInput(Input):
    fault_code_id: UUID
    equipment_type: str = Field(min_length=1, max_length=64)
    minutes: int = Field(gt=0, le=100000)


class TimeNormView(TimeNormInput, View):
    pass


class EmployeeInput(Input):
    login: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,63}$")
    display_name: str = Field(min_length=1, max_length=160)
    role: Literal["master", "executor", "manager", "admin"]
    specialty: str = Field(min_length=1, max_length=64)
    grade: int = Field(default=3, ge=1, le=6)
    brigade_id: UUID | None = None
    area_ids: list[UUID] = Field(default_factory=list, max_length=100)
    secret: SecretStr = Field(min_length=6, max_length=128)


class EmployeeView(View):
    login: str
    display_name: str
    role: str
    specialty: str
    grade: int
    brigade_id: UUID | None
    is_active: bool
    is_on_shift: bool


class AdminEmployeeView(EmployeeView):
    area_ids: list[UUID]


async def admin_employee_view(
    session: AsyncSession, employee: Employee
) -> AdminEmployeeView:
    area_ids = list(
        await session.scalars(
            select(EmployeeArea.area_id)
            .where(EmployeeArea.employee_id == employee.id)
            .order_by(EmployeeArea.area_id)
        )
    )
    return AdminEmployeeView(
        **EmployeeView.model_validate(employee).model_dump(), area_ids=area_ids
    )


class AccessUpdate(Input):
    is_on_shift: bool | None = None
    is_active: bool | None = None
    role: Literal["master", "executor", "manager", "admin"] | None = None
    area_ids: list[UUID] | None = Field(default=None, max_length=100)
    secret: SecretStr | None = Field(default=None, min_length=6, max_length=128)


class CatalogResponse(BaseModel):
    areas: list[AreaView]
    equipment: list[EquipmentView]
    brigades: list[BrigadeView]
    fault_codes: list[FaultView]
    materials: list[MaterialView]
    time_norms: list[TimeNormView]


@router.get("", response_model=CatalogResponse)
async def read_catalog(principal: PrincipalDep, database: DatabaseDep) -> CatalogResponse:
    async with database.sessions() as session:
        areas = select(Area).order_by(Area.code)
        equipment = select(Equipment).order_by(Equipment.inventory_number)
        if principal.role != "admin":
            areas = areas.where(Area.id.in_(principal.area_ids))
            equipment = equipment.where(Equipment.area_id.in_(principal.area_ids))
        planning_access = principal.role in {"master", "admin"}
        material_access = principal.role in {"executor", "master", "admin"}
        return CatalogResponse(
            areas=[AreaView.model_validate(r) for r in await session.scalars(areas)],
            equipment=[EquipmentView.model_validate(r) for r in await session.scalars(equipment)],
            brigades=[
                BrigadeView.model_validate(r)
                for r in await session.scalars(select(Brigade).order_by(Brigade.code))
            ]
            if planning_access
            else [],
            fault_codes=[
                FaultView.model_validate(r)
                for r in await session.scalars(select(FaultCode).order_by(FaultCode.code))
            ],
            materials=[
                MaterialView.model_validate(r)
                for r in await session.scalars(select(Material).order_by(Material.code))
            ]
            if material_access
            else [],
            time_norms=[
                TimeNormView.model_validate(r)
                for r in await session.scalars(select(TimeNorm).order_by(TimeNorm.id))
            ]
            if planning_access
            else [],
        )


@router.get("/equipment/{equipment_id}", response_model=EquipmentView)
async def equipment_detail(
    equipment_id: UUID, principal: PrincipalDep, database: DatabaseDep
) -> EquipmentView:
    async with database.sessions() as session:
        equipment = await session.get(Equipment, equipment_id)
        if equipment is None:
            raise HTTPException(status_code=404, detail="not_found")
        require_area(principal, equipment.area_id)
        return EquipmentView.model_validate(equipment)


@router.get("/employees", response_model=list[EmployeeView])
async def employees(
    principal: PrincipalDep,
    database: DatabaseDep,
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[EmployeeView]:
    if principal.role not in {"master", "manager", "admin"}:
        raise HTTPException(status_code=403, detail="staff_access_required")
    statement = select(Employee).order_by(Employee.login).limit(limit).offset(offset)
    if principal.role != "admin":
        statement = statement.where(
            Employee.id.in_(
                select(EmployeeArea.employee_id).where(EmployeeArea.area_id.in_(principal.area_ids))
            )
        )
    async with database.sessions() as session:
        return [EmployeeView.model_validate(row) for row in await session.scalars(statement)]


@router.get("/employees/{employee_id}", response_model=AdminEmployeeView)
async def employee_detail(
    employee_id: UUID, principal: PrincipalDep, database: DatabaseDep
) -> AdminEmployeeView:
    require_admin(principal)
    async with database.sessions() as session:
        employee = await session.get(Employee, employee_id)
        if employee is None:
            raise HTTPException(status_code=404, detail="not_found")
        return await admin_employee_view(session, employee)


@router.post("/employees", response_model=AdminEmployeeView, status_code=201)
async def create_employee(
    body: EmployeeInput, principal: PrincipalDep, database: DatabaseDep, request: Request
) -> AdminEmployeeView:
    require_admin(principal)
    hashed = await to_thread.run_sync(
        hash_secret, body.secret.get_secret_value(), limiter=request.app.state.auth_limiter
    )
    employee = Employee(**body.model_dump(exclude={"secret", "area_ids"}), password_hash=hashed)
    try:
        async with database.sessions.begin() as session:
            session.add(employee)
            await session.flush()
            session.add_all(
                [EmployeeArea(employee_id=employee.id, area_id=area) for area in set(body.area_ids)]
            )
            await session.flush()
            result = await admin_employee_view(session, employee)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.patch("/employees/{employee_id}/access", response_model=AdminEmployeeView)
async def change_access(
    employee_id: UUID,
    body: AccessUpdate,
    principal: PrincipalDep,
    database: DatabaseDep,
    request: Request,
) -> AdminEmployeeView:
    require_admin(principal)
    changes = body.model_dump(exclude_none=True, exclude={"secret", "area_ids"})
    hashed = (
        await to_thread.run_sync(
            hash_secret, body.secret.get_secret_value(), limiter=request.app.state.auth_limiter
        )
        if body.secret
        else None
    )
    try:
        async with database.sessions.begin() as session:
            employee = await session.scalar(
                select(Employee).where(Employee.id == employee_id).with_for_update()
            )
            if employee is None:
                raise HTTPException(status_code=404, detail="not_found")
            if employee.id == principal.employee_id and (
                body.is_active is False or (body.role is not None and body.role != "admin")
            ):
                raise HTTPException(status_code=409, detail="self_access_change_forbidden")
            if body.is_on_shift is False and await session.scalar(
                select(WorkOrder.id)
                .where(WorkOrder.executor_id == employee_id, WorkOrder.status == "in_progress")
                .limit(1)
            ):
                raise HTTPException(status_code=409, detail="worker_has_active_order")
            for key, value in changes.items():
                setattr(employee, key, value)
            if hashed:
                employee.password_hash = hashed
            if body.area_ids is not None:
                await session.execute(
                    delete(EmployeeArea).where(EmployeeArea.employee_id == employee_id)
                )
                session.add_all(
                    [
                        EmployeeArea(employee_id=employee_id, area_id=area)
                        for area in set(body.area_ids)
                    ]
                )
            await session.execute(
                update(AuthSession)
                .where(AuthSession.employee_id == employee_id, AuthSession.revoked_at.is_(None))
                .values(revoked_at=datetime.now(UTC))
            )
            await session.flush()
            result = await admin_employee_view(session, employee)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.post("/areas", response_model=AreaView, status_code=201)
async def create_areas(body: AreaInput, principal: PrincipalDep, database: DatabaseDep) -> AreaView:
    require_admin(principal)
    row = Area(**body.model_dump())
    try:
        async with database.sessions.begin() as session:
            session.add(row)
            await session.flush()
            result = AreaView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.put("/areas/{record_id}", response_model=AreaView)
async def replace_areas(
    record_id: UUID, body: AreaInput, principal: PrincipalDep, database: DatabaseDep
) -> AreaView:
    require_admin(principal)
    try:
        async with database.sessions.begin() as session:
            row = await session.get(Area, record_id, with_for_update=True)
            if row is None:
                raise HTTPException(status_code=404, detail="not_found")
            for field, value in body.model_dump().items():
                setattr(row, field, value)
            await session.flush()
            result = AreaView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.post("/brigades", response_model=BrigadeView, status_code=201)
async def create_brigades(
    body: BrigadeInput, principal: PrincipalDep, database: DatabaseDep
) -> BrigadeView:
    require_admin(principal)
    row = Brigade(**body.model_dump())
    try:
        async with database.sessions.begin() as session:
            session.add(row)
            await session.flush()
            result = BrigadeView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.put("/brigades/{record_id}", response_model=BrigadeView)
async def replace_brigades(
    record_id: UUID, body: BrigadeInput, principal: PrincipalDep, database: DatabaseDep
) -> BrigadeView:
    require_admin(principal)
    try:
        async with database.sessions.begin() as session:
            row = await session.get(Brigade, record_id, with_for_update=True)
            if row is None:
                raise HTTPException(status_code=404, detail="not_found")
            for field, value in body.model_dump().items():
                setattr(row, field, value)
            await session.flush()
            result = BrigadeView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.post("/equipment", response_model=EquipmentView, status_code=201)
async def create_equipment(
    body: EquipmentInput, principal: PrincipalDep, database: DatabaseDep
) -> EquipmentView:
    require_admin(principal)
    row = Equipment(**body.model_dump())
    try:
        async with database.sessions.begin() as session:
            session.add(row)
            await session.flush()
            result = EquipmentView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.put("/equipment/{record_id}", response_model=EquipmentView)
async def replace_equipment(
    record_id: UUID, body: EquipmentInput, principal: PrincipalDep, database: DatabaseDep
) -> EquipmentView:
    require_admin(principal)
    try:
        async with database.sessions.begin() as session:
            row = await session.get(Equipment, record_id, with_for_update=True)
            if row is None:
                raise HTTPException(status_code=404, detail="not_found")
            for field, value in body.model_dump().items():
                setattr(row, field, value)
            await session.flush()
            result = EquipmentView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.post("/fault-codes", response_model=FaultView, status_code=201)
async def create_fault_codes(
    body: FaultInput, principal: PrincipalDep, database: DatabaseDep
) -> FaultView:
    require_admin(principal)
    row = FaultCode(**body.model_dump())
    try:
        async with database.sessions.begin() as session:
            session.add(row)
            await session.flush()
            result = FaultView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.put("/fault-codes/{record_id}", response_model=FaultView)
async def replace_fault_codes(
    record_id: UUID, body: FaultInput, principal: PrincipalDep, database: DatabaseDep
) -> FaultView:
    require_admin(principal)
    try:
        async with database.sessions.begin() as session:
            row = await session.get(FaultCode, record_id, with_for_update=True)
            if row is None:
                raise HTTPException(status_code=404, detail="not_found")
            for field, value in body.model_dump().items():
                setattr(row, field, value)
            await session.flush()
            result = FaultView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.post("/materials", response_model=MaterialView, status_code=201)
async def create_materials(
    body: MaterialInput, principal: PrincipalDep, database: DatabaseDep
) -> MaterialView:
    require_admin(principal)
    row = Material(**body.model_dump())
    try:
        async with database.sessions.begin() as session:
            session.add(row)
            await session.flush()
            result = MaterialView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.put("/materials/{record_id}", response_model=MaterialView)
async def replace_materials(
    record_id: UUID, body: MaterialInput, principal: PrincipalDep, database: DatabaseDep
) -> MaterialView:
    require_admin(principal)
    try:
        async with database.sessions.begin() as session:
            row = await session.get(Material, record_id, with_for_update=True)
            if row is None:
                raise HTTPException(status_code=404, detail="not_found")
            for field, value in body.model_dump().items():
                setattr(row, field, value)
            await session.flush()
            result = MaterialView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.post("/time-norms", response_model=TimeNormView, status_code=201)
async def create_time_norms(
    body: TimeNormInput, principal: PrincipalDep, database: DatabaseDep
) -> TimeNormView:
    require_admin(principal)
    row = TimeNorm(**body.model_dump())
    try:
        async with database.sessions.begin() as session:
            session.add(row)
            await session.flush()
            result = TimeNormView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result


@router.put("/time-norms/{record_id}", response_model=TimeNormView)
async def replace_time_norms(
    record_id: UUID, body: TimeNormInput, principal: PrincipalDep, database: DatabaseDep
) -> TimeNormView:
    require_admin(principal)
    try:
        async with database.sessions.begin() as session:
            row = await session.get(TimeNorm, record_id, with_for_update=True)
            if row is None:
                raise HTTPException(status_code=404, detail="not_found")
            for field, value in body.model_dump().items():
                setattr(row, field, value)
            await session.flush()
            result = TimeNormView.model_validate(row)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="duplicate_or_invalid_reference") from None
    return result
