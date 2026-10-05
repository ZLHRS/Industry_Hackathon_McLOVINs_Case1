# Компоненты и использование AI

Реестр по П §5.8/§6.4. Версии и транзитивные зависимости — в uv.lock и frontend/package-lock.json.

| Компонент | Назначение |
| --- | --- |
| CPython 3.13.13 | Runtime backend |
| uv 0.11.19 | Окружение, lockfile, запуск, сборка |
| FastAPI / Starlette | HTTP и middleware |
| Pydantic / pydantic-settings | Контракты и настройки |
| Uvicorn | ASGI-сервер |
| PostgreSQL 16.15 | Локальная БД и интеграционные тесты; пакет Ubuntu без системной установки |
| SQLAlchemy 2.0.54 / psycopg 3.3.6 | Асинхронные соединения, ORM и транзакции |
| Alembic 1.20.0 | Версионирование схемы и проверка drift |
| argon2-cffi 25.1.0 | Хеширование секретов Argon2id |
| Pillow 12.3.0 | Валидация, нормализация, удаление метаданных и сжатие фото |
| pytest-asyncio | Тесты настоящих асинхронных сценариев |
| Hatchling | Сборка Python-пакета |
| pytest / pytest-cov / coverage | Тесты и покрытие |
| HTTPX2 | Асинхронный HTTPS-клиент ИИ и тестовый клиент Starlette |
| Ruff / mypy | Стиль, ошибки и типы, только dev |
| Actions / checkout / setup-uv | Подготовленный CI; удалённый запуск не подтверждён |
| Node.js 24.21.0 LTS | Локальная сборка frontend, закреплён .node-version |
| React / React DOM 19.3.0 | Ролевой интерфейс |
| TypeScript 6.0.3 / Vite 8.3.2 | Типизация и сборка PWA |
| Vitest 5.0.3 / fake-indexeddb 6.2.5 | Контракты API-клиента и офлайн-хранилища |
| Playwright 1.63.0 / установленный Microsoft Edge | Браузерные сценарии и снимки экрана |
| ESLint 10.12.0 / Prettier 3.9.9 | Статические проверки frontend |
| Codex и предоставленная .codex | AI-помощь в анализе, реализации, проверке |
| pypdf / pypdfium2 из runtime Codex | Чтение PDF задания; не зависимости приложения |

AI-инструмент разработки не является ИИ-модулем продукта.
Модель, провайдер и ограничения этапа 6 раскрыты ниже; промпт хранится в ai/repair_review.py.
Команда должна понимать и уметь объяснить код, включая созданный с AI.
Перед сдачей реестр дополняется моделями, лицензиями и источниками данных.
Seed полностью синтетический и не содержит фотографий или реальных персональных данных.
В тестах используются программно созданные изображения. API принимает фото пользователя
и хранит локально. Внешняя обработка требует ключа; изображения отправляются только
при явно включённом vision. Полного автоматического обезличивания изображений нет.

## Источники решений

- [uv: проекты и lockfile](https://docs.astral.sh/uv/guides/projects/).
- [FastAPI: lifespan](https://fastapi.tiangolo.com/advanced/events/) — для ресурсов
  БД; подключён на этапе 2.
- [Pydantic Settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/).
- Установленная starlette/testclient.py: Starlette 1.7.0 ожидает HTTPX2;
  устаревший httpx не используется как обход предупреждения.

- [SQLAlchemy asyncio](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html).
- [Alembic autogenerate/check](https://alembic.sqlalchemy.org/en/latest/autogenerate.html).
- [argon2-cffi: PasswordHasher](https://argon2-cffi.readthedocs.io/en/stable/api.html).
- [Pillow: Image, форматы и защита от decompression bomb](https://pillow.readthedocs.io/en/stable/reference/Image.html).

PDF пользователя автоматически не копируются в публичный репозиторий.
Матрица требований сохраняет названия документов, страницы и разделы.

- [Vite: требования к среде](https://vite.dev/guide/).
- [Node.js: официальный индекс выпусков](https://nodejs.org/dist/index.json); установщик проверяет SHASUMS256.txt.
- [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).

## Добавлено на этапе 5

- websockets: WebSocket transport в Uvicorn и реальные TCP-тесты.
- pywebpush, py-vapid, cryptography, requests: стандартное шифрование/VAPID и
  ограниченный HTTPS transport. Прямые зависимости объявлены отдельно в pyproject.toml,
  все версии и транзитивные компоненты зафиксированы uv.lock.
- Native Push API / Notification API: браузерная подписка и service worker.
  Внешний Telegram-бот не подключается.
- Новые уведомления формируются детерминированными правилами, не выдаются за результат LLM.
## Добавлено на этапе 6

- OpenAI Responses API; по умолчанию gpt-6.1-sol, модель настраивается.
  [Возможности модели](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
  [структурированные ответы](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses),
  [обработка изображений](https://developers.openai.com/api/docs/guides/images-vision).
- HTTPX2 используется в runtime для ограниченного асинхронного вызова провайдера.
- Локальные правила доказательств — код проекта; они не обозначаются как ответ LLM.
- Тестовые оценки ответов не измеряют точность модели на реальных ремонтах.
  Провайдер, данные и ограничения описаны в [stage-06.md](stage-06.md).
