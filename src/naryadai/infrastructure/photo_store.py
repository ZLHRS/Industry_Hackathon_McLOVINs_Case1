"""Private, normalized image persistence for work-order evidence.

The database owns the metadata transaction; this store owns only files. A
process crash between creating a file and committing metadata can leave an
orphan, so callers must delete files after a known transaction failure.
"""

from __future__ import annotations

import hashlib
import io
import os
import stat
import warnings
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar
from uuid import UUID, uuid4

from PIL import Image, ImageOps, UnidentifiedImageError


class PhotoStoreError(ValueError):
    """An untrusted image or a private-storage operation was rejected."""


@dataclass(frozen=True)
class StoredPhoto:
    storage_key: str
    sha256: str
    size_bytes: int
    content_type: str = "image/jpeg"


class PhotoStore:
    """Store normalized JPEGs under a private, UUID-only filesystem root."""

    _KEY_LENGTH = 40
    _FORMATS: ClassVar[dict[str, str]] = {
        "image/jpeg": "JPEG",
        "image/png": "PNG",
        "image/webp": "WEBP",
    }

    def __init__(
        self,
        root: Path,
        *,
        max_bytes: int,
        max_pixels: int,
        max_dimension: int,
        output_max_bytes: int,
    ) -> None:
        self.root = root
        self.max_bytes = max_bytes
        self.max_pixels = max_pixels
        self.max_dimension = max_dimension
        self.output_max_bytes = output_max_bytes
        self._ensure_private_root()

    def store(self, raw: bytes, content_type: str) -> StoredPhoto:
        if content_type not in self._FORMATS:
            raise PhotoStoreError("unsupported_media_type")
        if not raw or len(raw) > self.max_bytes:
            raise PhotoStoreError("image_too_large")
        normalized = self._normalize(raw, content_type)
        if len(normalized) > self.output_max_bytes:
            raise PhotoStoreError("normalized_image_too_large")
        storage_key = f"{uuid4()}.jpg"
        self._write_exclusive(self._path_for_key(storage_key), normalized)
        return StoredPhoto(storage_key, hashlib.sha256(normalized).hexdigest(), len(normalized))

    def read(self, storage_key: str) -> bytes:
        path = self._path_for_key(storage_key)
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags)
        except FileNotFoundError:
            raise PhotoStoreError("photo_not_found") from None
        except OSError as error:
            raise PhotoStoreError("unsafe_photo_path") from error
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise PhotoStoreError("unsafe_photo_path")
            with os.fdopen(descriptor, "rb", closefd=True) as stream:
                return stream.read()
        except Exception:
            with suppress(OSError):
                os.close(descriptor)
            raise

    def delete(self, storage_key: str) -> None:
        path = self._path_for_key(storage_key)
        try:
            metadata = os.lstat(path)
        except FileNotFoundError:
            return
        if not stat.S_ISREG(metadata.st_mode):
            raise PhotoStoreError("unsafe_photo_path")
        try:
            path.unlink()
        except FileNotFoundError:
            return
        except OSError as error:
            raise PhotoStoreError("photo_delete_failed") from error

    def _normalize(self, raw: bytes, content_type: str) -> bytes:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as verified:
                    if verified.format != self._FORMATS[content_type]:
                        raise PhotoStoreError("content_type_mismatch")
                    if getattr(verified, "n_frames", 1) != 1:
                        raise PhotoStoreError("animated_images_not_supported")
                    self._validate_dimensions(verified.size)
                    verified.verify()
                with Image.open(io.BytesIO(raw)) as source:
                    self._validate_dimensions(source.size)
                    image = ImageOps.exif_transpose(source)
                    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                        rgba = image.convert("RGBA")
                        flattened = Image.new("RGB", rgba.size, "white")
                        flattened.paste(rgba, mask=rgba.getchannel("A"))
                        image = flattened
                    else:
                        image = image.convert("RGB")
                    image.thumbnail(
                        (self.max_dimension, self.max_dimension), Image.Resampling.LANCZOS
                    )
                    return self._encode_bounded_jpeg(image)
        except PhotoStoreError:
            raise
        except (
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
            OSError,
            SyntaxError,
            UnidentifiedImageError,
            ValueError,
        ):
            raise PhotoStoreError("invalid_image") from None

    def _validate_dimensions(self, size: tuple[int, int]) -> None:
        width, height = size
        if width <= 0 or height <= 0 or width * height > self.max_pixels:
            raise PhotoStoreError("image_dimensions_not_allowed")

    def _encode_bounded_jpeg(self, image: Image.Image) -> bytes:
        candidate = image
        for _ in range(7):
            for quality in (85, 75, 65, 55, 45, 35, 25):
                output = io.BytesIO()
                candidate.save(
                    output, format="JPEG", quality=quality, optimize=True, progressive=True
                )
                if output.tell() <= self.output_max_bytes:
                    return output.getvalue()
            width, height = candidate.size
            if width <= 1 or height <= 1:
                break
            candidate = candidate.resize(
                (max(1, width * 4 // 5), max(1, height * 4 // 5)), Image.Resampling.LANCZOS
            )
        raise PhotoStoreError("normalized_image_too_large")

    def _ensure_private_root(self) -> None:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = os.lstat(self.root)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise PhotoStoreError("unsafe_photo_root")
        os.chmod(self.root, 0o700)

    def _path_for_key(self, storage_key: str) -> Path:
        if len(storage_key) != self._KEY_LENGTH or not storage_key.endswith(".jpg"):
            raise PhotoStoreError("unsafe_photo_path")
        try:
            if str(UUID(storage_key[:-4])) != storage_key[:-4]:
                raise ValueError
        except ValueError:
            raise PhotoStoreError("unsafe_photo_path") from None
        return self.root / storage_key

    def _write_exclusive(self, path: Path, data: bytes) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags, 0o600)
        except OSError as error:
            raise PhotoStoreError("photo_write_failed") from error
        try:
            with os.fdopen(descriptor, "wb", closefd=True) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(path, 0o600)
        except Exception:
            with suppress(OSError):
                path.unlink(missing_ok=True)
            raise
