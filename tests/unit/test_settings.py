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
