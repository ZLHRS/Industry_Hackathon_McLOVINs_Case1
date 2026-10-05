"""Typed analytics query and response contract."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from datetime import date as CalendarDate
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, model_validator

PeriodKind = Literal["shift", "day", "week", "month", "custom"]
ShiftKind = Literal["day", "night"]


class AnalyticsQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    period: PeriodKind = "day"
    shift: ShiftKind | None = None
    date: CalendarDate | None = None
    from_: datetime | None = Field(default=None, alias="from")
    to: datetime | None = None
    timezone: str = Field(default="Asia/Qostanay", min_length=1, max_length=64)
    area_ids: tuple[UUID, ...] = Field(default=(), max_length=100)
    equipment_ids: tuple[UUID, ...] = Field(default=(), max_length=100)
    executor_ids: tuple[UUID, ...] = Field(default=(), max_length=100)
    brigade_ids: tuple[UUID, ...] = Field(default=(), max_length=100)

    @model_validator(mode="after")
    def validate_period(self) -> AnalyticsQuery:
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("invalid_timezone") from error
        if self.date is not None and not 2 <= self.date.year <= 9998:
            raise ValueError("date_out_of_range")
        if self.period == "shift":
            if self.date is None or self.shift is None:
                raise ValueError("shift_requires_date_and_shift")
            if self.from_ is not None or self.to is not None:
                raise ValueError("shift_does_not_accept_from_to")
        elif self.period in {"day", "week", "month"}:
            if self.date is None:
                raise ValueError("calendar_period_requires_date")
            if self.shift is not None or self.from_ is not None or self.to is not None:
                raise ValueError("calendar_period_does_not_accept_shift_or_from_to")
        else:
            if self.from_ is None or self.to is None:
                raise ValueError("custom_requires_from_and_to")
            if self.date is not None or self.shift is not None:
                raise ValueError("custom_does_not_accept_date_or_shift")
            if not 2 <= self.from_.year <= 9998 or not 2 <= self.to.year <= 9998:
                raise ValueError("date_out_of_range")
            if self.from_.utcoffset() is None or self.to.utcoffset() is None:
                raise ValueError("custom_bounds_must_include_timezone")
            if self.to <= self.from_:
                raise ValueError("custom_to_must_follow_from")
            if self.to.astimezone(UTC) - self.from_.astimezone(UTC) > timedelta(days=366):
                raise ValueError("custom_range_exceeds_366_days")
        return self


class NamedValue(BaseModel):
    id: UUID
    name: str
    code: str | None = None


class PeriodView(BaseModel):
    kind: PeriodKind
    shift: ShiftKind | None = None
    timezone: str
    from_: datetime = Field(serialization_alias="from")
    to: datetime
    label: str


class FilterView(BaseModel):
    area_ids: list[UUID] = Field(default_factory=list)
    equipment_ids: list[UUID] = Field(default_factory=list)
    executor_ids: list[UUID] = Field(default_factory=list)
    brigade_ids: list[UUID] = Field(default_factory=list)


class ScopeView(BaseModel):
    role: str
    area_ids: list[UUID] = Field(default_factory=list)


class OrdersView(BaseModel):
    issued: int = 0
    completed: int = 0
    closed: int = 0
    overdue: int = 0
    rejected: int = 0
    backlog: int = 0


class DurationView(BaseModel):
    response_seconds: float | None = None
    work_seconds: float | None = None
    pause_seconds: float | None = None
    sample_sizes: dict[str, int] = Field(default_factory=dict)


class ActivityEmployeeView(BaseModel):
    employee_id: UUID
    employee_name: str
    active_seconds: float = 0
    paused_seconds: float = 0
    order_count: int = 0


class ActivityView(BaseModel):
    by_employee: list[ActivityEmployeeView] = Field(default_factory=list)
    active_order_count: int = 0
    active_seconds: float = 0


class DowntimeEquipmentView(BaseModel):
    equipment_id: UUID
    equipment_name: str
    known_seconds: float = 0
    order_ids: list[UUID] = Field(default_factory=list)
    unknown_order_count: int = 0


class DowntimeView(BaseModel):
    planned_seconds: float = 0
    unplanned_seconds: float = 0
    by_fault: dict[str, float] = Field(default_factory=dict)
    known_seconds: float = 0
    unknown_order_count: int = 0
    by_equipment: list[DowntimeEquipmentView] = Field(default_factory=list)


class RatingComponent(BaseModel):
    value: float | None = Field(default=None, ge=0, le=1)
    numerator: int | float | None = None
    denominator: int | float | None = None
    detail: str


class RatingView(BaseModel):
    subject_id: UUID
    subject_name: str
    score: float | None = Field(default=None, ge=0, le=100)
    sample_size: int = 0
    components: dict[str, RatingComponent] = Field(default_factory=dict)
    unavailable_components: list[str] = Field(default_factory=list)


class RatingsView(BaseModel):
    employees: list[RatingView] = Field(default_factory=list)
    brigades: list[RatingView] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class MaterialUsageView(BaseModel):
    material_id: UUID
    material_name: str
    unit: str
    quantity: float
    order_count: int


class MaterialBreakdownView(MaterialUsageView):
    dimension_id: UUID | None = None
    dimension_name: str | None = None


class MaterialsView(BaseModel):
    usage: list[MaterialUsageView] = Field(default_factory=list)
    by_area: list[MaterialBreakdownView] = Field(default_factory=list)
    by_equipment: list[MaterialBreakdownView] = Field(default_factory=list)
    by_executor: list[MaterialBreakdownView] = Field(default_factory=list)


class LeaderView(BaseModel):
    id: UUID
    name: str
    order_count: int
    overdue_count: int
    downtime_seconds: float = 0


class LeadersView(BaseModel):
    machines: list[LeaderView] = Field(default_factory=list)
    areas: list[LeaderView] = Field(default_factory=list)


class AnomalyView(BaseModel):
    family: Literal["recurring_fault", "after_ppr", "material_outlier", "rework_concentration"]
    severity: Literal["low", "medium", "high"]
    title: str
    evidence: dict[str, object]
    formula: str


class MetaView(BaseModel):
    as_of: datetime
    row_count: int
    synthetic_count: int = 0
    formula_descriptions: dict[str, str] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class AnalyticsReport(BaseModel):
    period: PeriodView
    filters: FilterView
    scope: ScopeView
    orders: OrdersView
    durations: DurationView
    activity: ActivityView
    downtime: DowntimeView
    ratings: RatingsView
    materials: MaterialsView
    leaders: LeadersView
    anomalies: list[AnomalyView] = Field(default_factory=list)
    meta: MetaView


class AnalyticsOptions(BaseModel):
    areas: list[NamedValue] = Field(default_factory=list)
    equipment: list[NamedValue] = Field(default_factory=list)
    executors: list[NamedValue] = Field(default_factory=list)
    brigades: list[NamedValue] = Field(default_factory=list)
