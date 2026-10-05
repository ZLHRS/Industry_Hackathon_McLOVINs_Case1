from __future__ import annotations

import io
import stat
from pathlib import Path

import pytest
from PIL import Image

from naryadai.infrastructure.photo_store import PhotoStore, PhotoStoreError


def _store(tmp_path: Path, **overrides: int) -> PhotoStore:
    options = {
        "max_bytes": 1024 * 1024,
        "max_pixels": 1_000_000,
        "max_dimension": 256,
        "output_max_bytes": 100_000,
    }
    options.update(overrides)
    return PhotoStore(tmp_path / "private-photos", **options)


def _image_bytes(
    fmt: str = "PNG", *, size: tuple[int, int] = (64, 32), **save_options: object
) -> bytes:
    image = Image.new("RGBA", size, (10, 40, 200, 120))
    output = io.BytesIO()
    image.save(output, format=fmt, **save_options)
    return output.getvalue()


def test_store_normalizes_to_private_jpeg_without_metadata(tmp_path: Path) -> None:
    store = _store(tmp_path)

    saved = store.store(_image_bytes(), "image/png")

    assert saved.storage_key.endswith(".jpg")
    assert saved.size_bytes <= store.output_max_bytes
    assert len(saved.sha256) == 64
    assert stat.S_IMODE(store.root.stat().st_mode) == 0o700
    path = store.root / saved.storage_key
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with Image.open(io.BytesIO(store.read(saved.storage_key))) as image:
        assert image.format == "JPEG"
        assert image.mode == "RGB"
        assert image.size == (64, 32)
        assert not image.getexif()


def test_store_rejects_invalid_mime_and_oversized_dimensions(tmp_path: Path) -> None:
    store = _store(tmp_path, max_pixels=100)
    with pytest.raises(PhotoStoreError, match="content_type_mismatch"):
        store.store(_image_bytes(), "image/jpeg")
    with pytest.raises(PhotoStoreError, match="image_dimensions_not_allowed"):
        store.store(_image_bytes(size=(11, 10)), "image/png")
    with pytest.raises(PhotoStoreError, match="invalid_image"):
        store.store(b"not-an-image", "image/png")


def test_store_limits_raw_size_and_rejects_unsafe_keys(tmp_path: Path) -> None:
    store = _store(tmp_path, max_bytes=10)
    with pytest.raises(PhotoStoreError, match="image_too_large"):
        store.store(_image_bytes(), "image/png")
    with pytest.raises(PhotoStoreError, match="unsafe_photo_path"):
        store.read("../outside.jpg")


def test_store_delete_is_idempotent(tmp_path: Path) -> None:
    store = _store(tmp_path)
    saved = store.store(_image_bytes(), "image/png")

    store.delete(saved.storage_key)
    store.delete(saved.storage_key)

    assert not (store.root / saved.storage_key).exists()


def test_store_rejects_animated_png_and_symlinked_objects(tmp_path: Path) -> None:
    store = _store(tmp_path)
    first = Image.new("RGB", (8, 8), "red")
    second = Image.new("RGB", (8, 8), "blue")
    animated = io.BytesIO()
    first.save(animated, format="PNG", save_all=True, append_images=[second])
    with pytest.raises(PhotoStoreError, match="animated_images_not_supported"):
        store.store(animated.getvalue(), "image/png")

    saved = store.store(_image_bytes(), "image/png")
    path = store.root / saved.storage_key
    path.unlink()
    path.symlink_to("/etc/passwd")
    with pytest.raises(PhotoStoreError, match="unsafe_photo_path"):
        store.read(saved.storage_key)
    with pytest.raises(PhotoStoreError, match="unsafe_photo_path"):
        store.delete(saved.storage_key)


def test_store_recompresses_noisy_image_below_output_limit(tmp_path: Path) -> None:
    store = _store(tmp_path, max_dimension=256, output_max_bytes=1_000)
    image = Image.effect_noise((256, 256), 100).convert("RGB")
    raw = io.BytesIO()
    image.save(raw, format="PNG")

    saved = store.store(raw.getvalue(), "image/png")

    assert saved.size_bytes <= 1_000
    with Image.open(io.BytesIO(store.read(saved.storage_key))) as normalized:
        assert max(normalized.size) < 256
