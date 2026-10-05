"""Validated input contracts for work-order commands."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from naryadai.infrastructure.models import Priority, WorkType


class MaterialLine(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    material_id: UUID
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)


class Completion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    work_description: str = Field(min_length=1, max_length=10_000)
    fault_code_id: UUID
    materials: tuple[MaterialLine, ...] = Field(default=(), max_length=100)
    no_materials_reason: str | None = Field(default=None, min_length=3, max_length=1_000)
    comment: str | None = Field(default=None, max_length=5_000)

    @model_validator(mode="after")
    def validate_materials(self) -> Completion:
        if not self.materials and self.no_materials_reason is None:
            raise ValueError("no_materials_reason is required when materials are empty")
        if self.materials and self.no_materials_reason is not None:
            raise ValueError("no_materials_reason is only allowed when materials are empty")
        if len({line.material_id for line in self.materials}) != len(self.materials):
            raise ValueError("materials must not contain duplicate material_id values")
        return self


class CreateOrder(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    work_type: WorkType
    description: str = Field(min_length=1, max_length=10_000)
    area_id: UUID
    equipment_id: UUID
    executor_id: UUID
    priority: Priority
    deadline: datetime
    fault_code_id: UUID | None = None
    comment: str | None = Field(default=None, max_length=5_000)

    @model_validator(mode="after")
    def validate_deadline(self) -> CreateOrder:
        if self.deadline.tzinfo is None or self.deadline.utcoffset() is None:
            raise ValueError("deadline must be timezone-aware")
        return self


OrderCommand = Literal[
    "accept",
    "queue",
    "reject",
    "start",
    "pause",
    "resume",
    "complete",
    "reassign",
    "cancel",
    "close",
    "override_close",
    "request_rework",
    "change_priority",
    "comment",
]


class OrderAction(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    action: OrderCommand
    expected_version: int = Field(ge=1)
    reason: str | None = Field(default=None, min_length=3, max_length=1_000)
    executor_id: UUID | None = None
    priority: Priority | None = None
    comment: str | None = Field(default=None, min_length=1, max_length=5_000)
    completion: Completion | None = None

    @model_validator(mode="after")
    def validate_action_payload(self) -> OrderAction:
        required_reason = {
            "reject",
            "pause",
            "reassign",
            "cancel",
            "override_close",
            "request_rework",
            "change_priority",
        }
        if self.action in required_reason and self.reason is None:
            raise ValueError(f"reason is required for {self.action}")
        if self.action not in required_reason and self.reason is not None:
            raise ValueError(f"reason is not allowed for {self.action}")
        if (self.action == "reassign") != (self.executor_id is not None):
            raise ValueError("executor_id is required only for reassign")
        if (self.action == "change_priority") != (self.priority is not None):
            raise ValueError("priority is required only for change_priority")
        if (self.action == "comment") != (self.comment is not None):
            raise ValueError("comment is required only for comment")
        if (self.action == "complete") != (self.completion is not None):
            raise ValueError("completion is required only for complete")
        return self
