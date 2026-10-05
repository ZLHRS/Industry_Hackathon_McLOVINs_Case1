# Компоненты и использование AI

Реестр по П §5.8/§6.4. Фактические версии и транзитивные зависимости backend — в uv.lock.

| Компонент | Назначение |
| --- | --- |
| CPython 3.13.13 | Runtime backend |
| uv 0.11.19 | Окружение, lockfile, запуск, сборка |
| FastAPI / Starlette | HTTP и middleware |
| Pydantic / pydantic-settings | Контракты и настройки |
| Uvicorn | ASGI-сервер |
| Hatchling | Сборка Python-пакета |
| pytest / pytest-cov / coverage | Тесты и покрытие |
| HTTPX2 | Тестовый клиент установленной Starlette, только dev |
| Ruff / mypy | Стиль, ошибки и типы, только dev |
| Actions / checkout / setup-uv | Подготовленный CI; удалённый запуск не подтверждён |
| Codex и предоставленная .codex | AI-помощь в анализе, реализации, проверке |
| pypdf / pypdfium2 из runtime Codex | Чтение PDF задания; не зависимости приложения |

AI-инструмент разработки не является ИИ-модулем продукта.
Модель, провайдер, промпты и ограничения будут добавлены на этапе 6.
Команда должна понимать и уметь объяснить код, включая созданный с AI.
Перед сдачей реестр дополняется frontend, БД, моделями, лицензиями и источниками данных.

## Источники решений

- [uv: проекты и lockfile](https://docs.astral.sh/uv/guides/projects/).
- [FastAPI: lifespan](https://fastapi.tiangolo.com/advanced/events/) — для ресурсов
  БД/провайдеров будущих этапов; сейчас таких ресурсов нет.
- [Pydantic Settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/).
- Установленная starlette/testclient.py: Starlette 1.7.0 ожидает HTTPX2;
  устаревший httpx не используется как обход предупреждения.

PDF пользователя автоматически не копируются в публичный репозиторий.
Матрица требований сохраняет названия документов, страницы и разделы.