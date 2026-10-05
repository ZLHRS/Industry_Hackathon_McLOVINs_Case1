import importlib.util
from pathlib import Path

import pytest
from sqlalchemy.engine import make_url

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "frontend_test_server.py"
_SPEC = importlib.util.spec_from_file_location("frontend_test_server", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


def test_refuses_non_test_database_targets() -> None:
    with pytest.raises(_MODULE.E2EServerError, match="end in _test"):
        _MODULE._require_test_database_url("postgresql+psycopg://user:pass@localhost/naryadai")
    with pytest.raises(_MODULE.E2EServerError, match="valid database URL"):
        _MODULE._require_test_database_url("not a url")


def test_schema_url_is_limited_to_private_e2e_names() -> None:
    base = "postgresql+psycopg://user:pass@localhost/naryadai_test"
    schema = "e2e_0123456789abcdef0123456789abcdef"
    with pytest.raises(_MODULE.E2EServerError, match="unexpected E2E schema"):
        _MODULE._schema_url(base, "public")
    assert make_url(_MODULE._schema_url(base, schema)).query["options"] == "-csearch_path=" + schema


def test_state_file_is_restricted_to_ignored_tmp_directory() -> None:
    assert _MODULE._metadata_path("tmp/e2e-server.json").name == "e2e-server.json"
    with pytest.raises(_MODULE.E2EServerError, match="ignored tmp"):
        _MODULE._metadata_path("../e2e-server.json")
