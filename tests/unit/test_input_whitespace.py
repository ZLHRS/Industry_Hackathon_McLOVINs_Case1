"""User text is normalized before validation without changing credentials."""

import pytest
from pydantic import ValidationError

from naryadai.api.auth import LoginRequest
from naryadai.api.catalog import AccessUpdate, AreaInput
from naryadai.application.contracts import OrderAction
from naryadai.application.master_assistant import AssistantQuestion


def test_assistant_trims_before_length_validation():
    question = "x" * 500
    assert AssistantQuestion(question=f"  {question}\n").question == question
    with pytest.raises(ValidationError):
        AssistantQuestion(question=" \n\t ")


def test_catalog_and_action_trim_but_preserve_internal_text():
    area = AreaInput(code="  AREA-1\t", name="  North  section\n")
    assert area.code == "AREA-1"
    assert area.name == "North  section"
    action = OrderAction(action="comment", expected_version=1, comment="  Line 1\nLine 2  ")
    assert action.comment == "Line 1\nLine 2"
    with pytest.raises(ValidationError):
        OrderAction(action="comment", expected_version=1, comment="   ")


def test_login_normalizes_username_but_preserves_password():
    request = LoginRequest(login="  demo.master1  ", secret=" password ")
    assert request.login == "demo.master1"
    assert request.secret.get_secret_value() == " password "
    assert AccessUpdate(secret=" password ").secret.get_secret_value() == " password "
