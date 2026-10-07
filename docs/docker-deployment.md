# Docker и technaryad.online

Приложение работает на этом компьютере. Для доступа из интернета компьютер
должен быть включён, подключён к сети и не спать; Docker Desktop должен работать.
Туннель подключается к Cloudflare исходящим соединением. Проброс портов роутера
не нужен. Локальный адрес: http://127.0.0.1:8080.

## Первый запуск

```sh
python3 scripts/docker_setup.py
docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.docker --profile demo up seed
docker compose --env-file .env.docker cp seed:/app/var/industrial-credentials.txt var/docker/industrial-credentials.txt
chmod 600 var/docker/industrial-credentials.txt
```

Скрипт создаёт `.env.docker` и `var/docker/secrets/` с закрытыми правами.
Повторный вызов сохраняет существующие настройки и пароли. Seed идемпотентен:
повторное применение сохраняет существующий промышленный набор без дубликатов.
Данные Docker независимы от нативной локальной БД; пароли аккаунтов смотрите
в `var/docker/industrial-credentials.txt`, не в старом `var/industrial-credentials.txt`.
Не публикуйте эти файлы. Учётные данные и данные БД не входят в образы.

## Публичный адрес

Для technaryad.online у Namecheap назначены:

- `hadlee.ns.cloudflare.com`
- `tosana.ns.cloudflare.com`

В Cloudflare записи корня и `www` направлены на туннель `technaryad-local`,
UUID `12ba2127-c54a-4949-b0d6-b5e346972752`. Пять MX и SPF TXT сохранены.
DNS и выпуск сертификата после смены NS требуют времени; успешный запуск
контейнера сам по себе не подтверждает доступность публичного HTTPS.

7 октября публичный адрес https://technaryad.online и вариант с www проверены:
readiness успешен, вход рабочих ролей и защищённый WebSocket работают.
Обычный HTTP автоматически перенаправляется на HTTPS (308).

Локальный файл `var/docker/tunnel/credentials.json` разрешает запуск только
этого туннеля. Он смонтирован как secret. Сертификат управления аккаунтом
Cloudflare не передаётся контейнеру. На другом компьютере потребуется безопасно
перенести этот файл либо создать собственный туннель и обновить его UUID/DNS.

В `.env.docker`:

```dotenv
NARYADAI_ALLOWED_HOSTS=["localhost","127.0.0.1","technaryad.online","www.technaryad.online"]
NARYADAI_CORS_ORIGINS=[]
NARYADAI_SITE_ADDRESS=http://:80
```

Создайте постоянный VAPID-ключ Web Push (после установки Python-зависимостей
проекта через `uv sync --locked`); повторный запуск сохраняет ключ:

```sh
.venv/bin/python scripts/dev_push.py --key-file var/docker/secrets/vapid_private.pem --subject https://technaryad.online
```

Ключ монтируется API и worker как secret. Не удаляйте его при пересборке:
существующие подписки телефона привязаны к этому ключу.

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml up -d --build
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml ps
curl --fail https://technaryad.online/api/v1/health/ready
```

Cloudflare завершает публичный TLS. Туннель обращается к приватному
`http://web:8081`; этот порт не опубликован на компьютере. Caddy проверяет имя
домена и сообщает API исходную схему HTTPS. Не задавайте `httpHostHeader` и не
подменяйте Host в cloudflared: это нарушит проверку источника WebSocket.
API доверяет proxy headers только Caddy `10.77.88.2`. Подсеть прокси
`10.77.88.0/24` должна быть свободна; при переносе меняйте её согласованно
в compose и `deploy/Dockerfile.api`. CORS остаётся пустым для same-origin PWA.

## Обновление, остановка и сохранение

```sh
# Пересборка сохраняет named volumes с БД и фотографиями.
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml up -d --build
# Остановить только внешний доступ:
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml stop tunnel
# Остановить приложение, сохранив данные:
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml stop
```

Не используйте `down -v`: эта команда удаляет данные volumes. Перед переносом
или изменением схемы сохраните dump БД и архив фотографий, а также приватные
настройки/секреты. Пример dump:

```sh
mkdir -p var/docker/backups
chmod 700 var/docker/backups
docker compose --env-file .env.docker exec -T postgres pg_dump -U naryadai -d naryadai -Fc > var/docker/backups/naryadai.dump
chmod 600 var/docker/backups/naryadai.dump
```

После запуска проверьте вход, выдачу наряда и обновление второй сессии, загрузку
фото, установку PWA и офлайн на физическом телефоне. Без AI API key действует
локальная проверка; Docker-запуск не включает живую модель автоматически.

Для явного включения внешней модели сохраните действующий ключ в закрытый файл
`var/docker/secrets/ai_api_key` (права 600) и добавьте `-f compose.ai.yaml` к команде
Compose. Ключ читается entrypoint из Docker secret; он не интерполируется из `.env`
и не появляется в `docker compose config`. Не включайте этот overlay без нового
действующего ключа. Ключ, который попал в диагностический вывод 7 октября,
нужно отозвать у провайдера. 8 октября пользователь настроил новый ключ через
защищённый ввод; новое подключение и vision включены в опубликованном worker.

Безопасный ввод и проверка нового подключения:

```sh
.venv/bin/python scripts/configure_ai.py
.venv/bin/python scripts/eval_ai.py --execute --key-file var/docker/secrets/ai_api_key --model gpt-5.4
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml -f compose.ai.yaml up -d
```

Скрипт не отображает вводимый ключ; файл получает права 600. Проверка отправляет
только синтетические примеры и пишет отдельный результат в `tmp/ai-eval/`.
Overlay включает анализ фото у worker. Модель можно изменить через
`NARYADAI_AI_MODEL` в `.env.docker`; сам ключ туда не добавляйте. Проверьте результат
живого запуска перед демонстрацией. Старые fallback-отчёты автоматически не меняются.
После включения ИИ при каждом обновлении сохраняйте `-f compose.ai.yaml` в команде
`up`: иначе Compose пересоздаст сервисы без этого secret. Текущая команда обновления:

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.tunnel.yaml -f compose.ai.yaml up -d --build
```

## Проверка резервной копии

```sh
.venv/bin/python scripts/backup_restore.py
```

Команда сохраняет PostgreSQL dump и архив фотографий в закрытую папку
`var/backups/<дата>/`, затем восстанавливает dump в одноразовом контейнере без сети
и опубликованных портов. Сравниваются количества нарядов, событий, списаний и фото;
рабочая база не перезаписывается. Отчёт: `tmp/review/completion-backup-restore.json`.

Эта проверка подтверждает чтение архива и восстановление схемы/данных с ограничениями.
Она не восстанавливает весь сервис, владельцев/права БД или секреты. Для аварийного
переноса отдельно сохраняйте закрытые настройки, VAPID и разрешение туннеля;
сначала репетируйте полный запуск на отдельном стенде. Во время интенсивной записи
фото для согласованной резервной копии нужен согласованный перерыв записи.

Официальные источники: [локальный именованный туннель](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/),
[права сертификата и credentials](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/tunnel-permissions/).

## Фото и обновление схемы 0006

Миграция `0006_photo_ai_consent` добавляет разрешение передачи каждого фото внешней
модели. Для всех старых и новых снимков значение по умолчанию — `false`.
Само включение vision в worker не разрешает отправку всех изображений: байты
передаются только для снимков с явным разрешением. Перед разрешением пользователь
проверяет фото и скрывает чувствительные области встроенным редактором.

Перед изменением схемы можно выполнить проверяемую резервную копию:

```sh
.venv/bin/python scripts/backup_restore.py
```

Скрипт сохраняет dump и архив фото в `var/backups/`, восстанавливает БД во временном
изолированном контейнере и сверяет каждый файл фото с БД по размеру и SHA-256.
Он не меняет рабочую БД. Секреты сервиса/DNS и полное восстановление на другом
сервере проверяются отдельно. Текущие результаты — в
[техническом отчёте](technical-completion-2026-10-08.md).


## Репетиция восстановления всего приложения

После создания проверенной резервной копии:

```sh
.venv/bin/python scripts/verify_operations.py --execute --backup var/backups/<дата>
```

Нужны Docker, локальные образы `technaryad-api:local`, `technaryad-web:local`,
образ PostgreSQL из Compose и действующий пароль тестового мастера в закрытом
`var/docker/industrial-credentials.txt`. Копия должна содержать активное оборудование
и исполнителя на смене; эти предпосылки относятся к демонстрационному стенду.
Скрипт никогда не заменяет рабочую БД и не перезапускает рабочие контейнеры.

Создаётся отдельная внутренняя Docker-сеть без опубликованных портов. В копию
восстанавливаются БД и фотографии; приложение работает от непривилегированной
роли БД. Каталог фото расположен в отдельном записываемом volume с владельцем
10001 и правами 0700, файлы — 0600. Read-only подключение каталога непригодно:
приложение создаёт фото и проверяет права каталога при старте.

Проверяются вход, статические файлы PWA, защищённое чтение фото и их SHA-256,
запись наряда, сохранность сессии/идемпотентности после аварийного перезапуска API,
возврат БД после рестарта, обработка сохранённых событий после перезапуска worker
и ограниченная параллельная нагрузка. Секреты ИИ, VAPID и туннеля в копию не
подключаются; доставка во внешние сервисы не проверяется. Результат с ограничениями
и удалением временных ресурсов записывается в `tmp/review/operations-<дата>.json`.

Подтверждённая репетиция 8 октября: 603 наряда, 3748 событий, 1082 списания, 2 фото;
120 запросов при параллельности 20, ошибок 0, p95 1468,74 мс на локальной копии.
[Полный результат](submission/operations-recovery.json). Это не нагрузочная
сертификация предприятия и не перенос DNS/TLS/Push-секретов на другой сервер.
