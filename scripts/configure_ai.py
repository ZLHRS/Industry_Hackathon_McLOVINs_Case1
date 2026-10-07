# ruff: noqa: RUF001
"""Store a freshly rotated AI key privately, without shell history or console output."""

from __future__ import annotations

import getpass
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def save_key(root: Path, key: str) -> Path:
    value = key.strip()
    if not value.startswith("sk-") or len(value) < 30 or any(c.isspace() for c in value):
        raise ValueError("Нужен непустой API-ключ OpenAI без пробелов.")
    directory = root / "var/docker/secrets"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = directory / "ai_api_key"
    descriptor, temporary = tempfile.mkstemp(prefix=".ai-key-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(value + "\n")
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return destination


def main() -> None:
    print("Настройка ИИ. Ключ не появится на экране и не попадёт в историю команд.")
    print("Сначала отзовите ранее раскрытый ключ в аккаунте провайдера.")
    if input("Старый ключ отозван, а новый создан? Введите да: ").strip().lower() != "да":
        raise SystemExit("Настройки не изменены.")
    try:
        save_key(ROOT, getpass.getpass("Новый API-ключ: "))
    except ValueError as error:
        raise SystemExit(str(error)) from None
    print("Новый ключ сохранён с правами 600. Содержимое не выводилось.")
    print("Для подключения используется compose.ai.yaml; сообщения чата для ключа не нужны.")


if __name__ == "__main__":
    main()
