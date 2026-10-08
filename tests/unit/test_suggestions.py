from naryadai.application.suggestions import _fault_match
from naryadai.infrastructure.models import FaultCode


def _fault(code: str = "HYD001", name: str = "Утечка масла") -> FaultCode:
    return FaultCode(code=code, name=name, specialty="mechanic")


def test_fault_text_matching_accepts_synonym_and_separated_code_but_not_substring():
    assert _fault_match(_fault(), "подтекает масло")[0] > 0
    assert _fault_match(_fault(), "проверить HYD-001")[0] >= 100
    assert _fault_match(_fault(), "проверить HYD0010")[0] == 0
    assert _fault_match(_fault(), "квантовый арбуз")[0] == 0


def test_fault_text_matching_ignores_generic_action_words_without_object_evidence():
    fence = _fault("GEN005", "Проверка ограждения")
    assert _fault_match(fence, "требуется проверка оборудования")[0] == 0
    assert _fault_match(fence, "перегрев двигателя, требуется проверка")[0] == 0
    assert _fault_match(fence, "требуется проверка ограждения")[0] > 0
