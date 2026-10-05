import pytest
from pydantic import ValidationError

from naryadai.config import Environment, Settings


def test_environment_overrides_defaults(monkeypatch):
    monkeypatch.setenv("NARYADAI_ENVIRONMENT", "test")
    monkeypatch.setenv("NARYADAI_LOG_LEVEL", "warning")
    monkeypatch.setenv("NARYADAI_ALLOWED_HOSTS", '["api.local"]')
    monkeypatch.setenv("NARYADAI_CORS_ORIGINS", '["https://app.local"]')
    settings = Settings()
    assert settings.environment == Environment.TEST
    assert settings.log_level == "WARNING"
    assert settings.allowed_hosts == ("api.local",)
    assert settings.cors_origins == ("https://app.local",)


@pytest.mark.parametrize(
    "overrides",
    [
        {"environment": "staging_typo"},
        {"log_level": "TRACE"},
        {"allowed_hosts": []},
        {"allowed_hosts": [""]},
        {"allowed_hosts": ["*"]},
        {"allowed_hosts": ["*.example.com"]},
        {"allowed_hosts": ["https://api.local"]},
        {"allowed_hosts": ["api.local:8000"]},
        {"allowed_hosts": ["api.local/path"]},
        {"allowed_hosts": [" api.local"]},
        {"cors_origins": ["*"]},
        {"cors_origins": ["https://*.local"]},
        {"cors_origins": ["ftp://api.local"]},
        {"cors_origins": ["https://api.local/"]},
        {"cors_origins": ["https://user:pass@api.local"]},
        {"cors_origins": ["https://api.local?token=secret"]},
        {"cors_origins": ["https://api.local#secret"]},
        {"cors_origins": ["https://api.local:99999"]},
        {"cors_origins": ["https://bad host.local"]},
        {"environment": "production", "log_level": "DEBUG"},
        {"environment": "production", "cors_origins": ["http://app.local"]},
    ],
)
def test_invalid_settings_fail_at_startup(overrides):
    with pytest.raises(ValidationError):
        Settings(**overrides)


def test_production_accepts_explicit_secure_origin():
    settings = Settings(environment="production", cors_origins=["https://app.example.com"])
    assert settings.environment == Environment.PRODUCTION


def test_dotenv_is_utf8_and_optional(tmp_path):
    (tmp_path / ".env").write_text("NARYADAI_LOG_LEVEL=error\n", encoding="utf-8")
    assert Settings().log_level == "ERROR"


@pytest.mark.parametrize(
    "value",
    [
        "sqlite:///local.db",
        "postgresql://user:secret@localhost/db",
        "postgresql+psycopg://localhost",
        "not-a-url",
    ],
)
def test_only_explicit_psycopg_database_urls_are_accepted(value):
    with pytest.raises(ValidationError):
        Settings(database_url=value)


def test_database_url_is_redacted():
    settings = Settings(database_url="postgresql+psycopg://user:sensitive-secret@localhost/db")
    assert "sensitive-secret" not in repr(settings)
    assert "sensitive-secret" not in settings.model_dump_json()


@pytest.mark.parametrize(
    "values",
    [
        {"session_ttl_seconds": 0},
        {"login_account_limit": 0},
        {"login_peer_limit": 0},
        {"login_window_seconds": 1},
    ],
)
def test_session_and_login_limits_are_bounded(values):
    with pytest.raises(ValidationError):
        Settings(**values)


@pytest.mark.parametrize("contact", ["mailto:owner@example.org", "https://github.com/team/project"])
def test_web_push_contact_uri(contact):
    assert Settings(web_push_subject=contact).web_push_subject == contact


@pytest.mark.parametrize(
    "contact",
    [
        "http://example.org",
        "owner@example.org",
        "https://a b.org",
        "https://user:pass@example.org",
        "mailto:user@example.org?body=x",
        "https://example.org/#fragment",
        "x" * 513,
    ],
)
def test_invalid_web_push_contact_uri(contact):
    with pytest.raises(ValueError):
        Settings(web_push_subject=contact)


@pytest.mark.parametrize(
    "setting",
    [
        "reminder_minutes",
        "acceptance_minutes",
        "emergency_acceptance_minutes",
        "overdue_repeat_minutes",
        "manager_escalation_minutes",
        "push_timeout_seconds",
        "push_max_attempts",
        "push_lease_seconds",
        "worker_interval_seconds",
        "realtime_poll_seconds",
    ],
)
def test_notification_intervals_are_positive(setting):
    with pytest.raises(ValueError):
        Settings(**{setting: 0})


@pytest.mark.parametrize(
    "overrides",
    [
        {"ai_timeout_seconds": 0},
        {"ai_total_timeout_seconds": 4},
        {"ai_max_attempts": 6},
        {"ai_lease_seconds": 35},
        {"ai_timeout_seconds": 60, "ai_total_timeout_seconds": 45},
        {"ai_model": "model\nAuthorization: leak"},
        {"ai_model": ""},
        {"ai_reasoning_effort": "max"},
        {"ai_max_output_tokens": 8193},
        {"ai_max_output_tokens": 1024},
    ],
)
def test_ai_bounds_reject_unsafe_runtime_configuration(overrides):
    with pytest.raises(ValidationError):
        Settings(**overrides)


def test_ai_secret_is_private_and_missing_key_disables_external_service(monkeypatch):
    assert Settings().ai_api_key is None
    assert not Settings().ai_vision_enabled
    assert Settings(ai_api_key=" ").ai_api_key is None
    monkeypatch.setenv("NARYADAI_AI_API_KEY", "private-api-credential")
    settings = Settings()
    assert settings.ai_api_key.get_secret_value() == "private-api-credential"
    assert "private-api-credential" not in repr(settings)
    assert "private-api-credential" not in settings.model_dump_json()
    with pytest.raises(ValidationError) as error:
        Settings(ai_api_key="private-api-credential", ai_lease_seconds=35)
    assert "private-api-credential" not in str(error.value)
