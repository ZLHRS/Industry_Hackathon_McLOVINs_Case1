<div align="center">

<img src="frontend/public/icon-192.png" alt="ТехНаряд" width="80" height="80">

# ТехНаряд

Наряды на ремонт: мастер назначает работу, исполнитель сдаёт результат,
система проверяет отчёт, мастер принимает ремонт.

**McLOVINs · QOSTANAI AI INDUSTRY HACKATHON 2026**

[Открыть приложение](https://technaryad.online/) · [Требования кейса](docs/requirements.md)

</div>

## Запуск

Выберите один способ. Команды выполняются из корня проекта.
На Windows используйте Ubuntu/WSL. Для Docker включите Docker Desktop
с Linux-контейнерами. Для локального запуска нужен установленный `uv`.

### 1. Локально — первый запуск на Ubuntu/WSL

```bash
uv sync --locked
uv run --locked python scripts/dev_frontend.py bootstrap
bash scripts/frontend.sh ci
uv run --locked python scripts/dev_database.py bootstrap
uv run --locked python scripts/demo.py --seed
```

Открыть: **http://localhost:5173**.
Команда запускает базу, миграции, сид, бэкенд, worker и фронтенд.
Отдельно запускать их не нужно. Остановка — **Ctrl+C**.

### Локально — повторный запуск

```bash
uv run --locked python scripts/demo.py
```

### 2. Docker — локально

```bash
python3 scripts/docker_setup.py
docker compose --env-file .env.docker up -d --build
```

Открыть: **http://localhost:8080**. База Docker отдельная от локальной.
Для первого входа заполните её сидом — команды ниже.

Остановить, сохранив данные:

```bash
docker compose --env-file .env.docker stop
```

### 3. С телефона — временная ссылка

Сначала выполните первый локальный запуск и остановите его через Ctrl+C.
Установите [cloudflared](docs/phone-tunnel.md), затем:

```bash
uv run --locked python scripts/dev_database.py start
uv run --locked python scripts/phone_tunnel.py
```

Откройте на телефоне адрес из строки **`Open on your phone: https://…trycloudflare.com`**.
Бэкенд, фронтенд, worker и туннель запускаются автоматически.
Терминал оставьте открытым. После перезапуска ссылка меняется.

### 4. На домене — настроенный сервер

Первичная настройка домена, туннеля и push: [инструкция](docs/docker-deployment.md).
Команды выполняйте на компьютере, который обслуживает домен.

Без внешнего ИИ:

```bash
python3 scripts/docker_setup.py
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml up -d --build
```

С настроенным API-ключом ИИ:

```bash
python3 scripts/docker_setup.py
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml -f compose.ai.yaml up -d --build
```

Открыть: **https://technaryad.online/**. Компьютер и Docker должны работать.
Локальный запуск на другом ноутбуке сам по себе домен не обновляет.

### Обновить домен после отправки изменений в Git

На компьютере, обслуживающем домен, при уже настроенном ИИ:

```bash
git pull --ff-only
python3 scripts/docker_setup.py
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml -f compose.ai.yaml up -d --build
curl --fail https://technaryad.online/api/v1/health/ready
```

Если ИИ не настроен, уберите `-f compose.ai.yaml`. База и фото сохраняются;
повторно применять сид для обновления кода не нужно.

## Сид — заполнить данными

600 вымышленных нарядов, 25 машин, 19 сотрудников, материалы и история ремонтов.
За последние 90 дней — 500+ нарядов. Три задания имеют сроки через 12–14 дней
от генерации, чтобы на показе оставались актуальные работы.

### Локальная пустая база

Первый запуск `demo.py --seed` уже загружает данные. Если пропустили этот шаг,
остановите API и worker и выполните:

```bash
uv run --locked python scripts/dev_database.py start
uv run --locked alembic upgrade head
uv run --locked python -m seeds.industrial apply
uv run --locked python scripts/demo.py
```

### Пустая база Docker

```bash
docker compose --env-file .env.docker --profile demo up seed
docker compose --env-file .env.docker cp seed:/app/var/industrial-credentials.txt var/docker/industrial-credentials.txt
chmod 600 var/docker/industrial-credentials.txt
```

Повторный `apply` не обновляет даты существующего набора и не меняет пароли.
Замена данных и резервные копии описаны [в инструкции сида](seeds/industrial/README.md).
Не используйте `docker compose down -v`: это удаляет данные.

## Вход

| Роль | Логин |
| --- | --- |
| Мастер | `master.sadykov` или `master.orlova` |
| Исполнитель | `exec.amanov` |
| Руководитель | `manager.tulegen` |
| Администратор | `admin.karim` |

Пароль нового сида по умолчанию: **`TechNaryad2026!`**.
Если раньше был задан другой пароль, он сохраняется. Фактические данные входа:

- локально — `var/industrial-credentials.txt`;
- Docker — `var/docker/industrial-credentials.txt`.

## Что есть в приложении

- **Мастер:** выдача нарядов, загрузка сотрудников, QR оборудования, приёмка ремонта.
- **Исполнитель:** свои задания, очередь, паузы, материалы и фотографии результата.
- **Руководитель:** отчёты, рейтинги, простои, расход материалов и Excel.
- **Администратор:** сотрудники, роли, участки и справочники.

Доступны уведомления, обновления в реальном времени и установка на телефон как PWA.
ИИ рекомендует решение; окончательное слово остаётся за мастером.

## Подробные инструкции

- [Docker, домен и API-ключ ИИ](docs/docker-deployment.md)
- [Телефон и push-уведомления](docs/phone-tunnel.md)
- [Сид и учётные записи](seeds/industrial/README.md)
- [Локальная разработка и тесты фронтенда](docs/stage-04.md)
- [Настройка проверки ремонта](docs/stage-06.md)
- [Архитектура](docs/architecture.md)
