# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class ObjectInfo:
    uri: str
    size: int
    generation: int | None
    created: datetime | None
    metadata: dict[str, str]


class BlobExistsError(FileExistsError):
    pass


class BlobStore(Protocol):
    def list(self, prefix: str) -> Iterator[ObjectInfo]: ...
    def read(self, uri: str, generation: int | None = None) -> bytes: ...
    def write(self, uri: str, data: bytes, *, overwrite: bool, metadata: dict[str, str] | None = None) -> None: ...
    def copy(self, src: str, dst: str, *, overwrite: bool) -> None: ...
    def exists(self, uri: str) -> bool: ...
    def info(self, uri: str) -> ObjectInfo | None: ...
    def upload(self, path: Path, uri: str, *, overwrite: bool) -> None: ...
    def md5(self, uri: str) -> str | None: ...


class LocalBlobStore:
    """Maps `file://` or bare paths onto a directory; used by run-local and tests."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()

    def _path(self, uri: str) -> Path:
        rel = uri.removeprefix("file://")
        path = (self.root / rel).resolve() if not Path(rel).is_absolute() else Path(rel)
        if self.root not in path.parents and path != self.root:
            raise ValueError(f"{uri} escapes {self.root}")
        return path

    def list(self, prefix: str) -> Iterator[ObjectInfo]:
        base = self._path(prefix)
        if base.is_file():
            candidates = [base]
        else:
            candidates = (
                sorted(p for p in base.rglob("*") if p.is_file() and not p.name.startswith("."))
                if base.exists()
                else []
            )
        for path in candidates:
            stat = path.stat()
            yield ObjectInfo(
                uri=str(path),
                size=stat.st_size,
                generation=None,
                created=datetime.fromtimestamp(stat.st_mtime, tz=UTC),
                metadata={},
            )

    def read(self, uri: str, generation: int | None = None) -> bytes:
        return self._path(uri).read_bytes()

    def write(self, uri: str, data: bytes, *, overwrite: bool, metadata: dict[str, str] | None = None) -> None:
        path = self._path(uri)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        _place(Path(tmp_name), path, overwrite, uri)

    def copy(self, src: str, dst: str, *, overwrite: bool) -> None:
        self.upload(self._path(src), dst, overwrite=overwrite)

    def exists(self, uri: str) -> bool:
        return self._path(uri).is_file()

    def info(self, uri: str) -> ObjectInfo | None:
        path = self._path(uri)
        if not path.is_file():
            return None
        stat = path.stat()
        return ObjectInfo(str(path), stat.st_size, None, datetime.fromtimestamp(stat.st_mtime, tz=UTC), {})

    def upload(self, path: Path, uri: str, *, overwrite: bool) -> None:
        dst = self._path(uri)
        dst.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{dst.name}.", dir=dst.parent)
        os.close(fd)
        shutil.copyfile(path, tmp_name)
        _place(Path(tmp_name), dst, overwrite, uri)

    def md5(self, uri: str) -> str | None:
        path = self._path(uri)
        if not path.is_file():
            return None
        digest = hashlib.md5()  # noqa: S324 - integrity only
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()


def _place(tmp: Path, dst: Path, overwrite: bool, uri: str) -> None:
    """Atomic move of a finished temp file; without overwrite it is write-if-absent via a hard link."""
    try:
        if overwrite:
            tmp.replace(dst)
            return
        try:
            os.link(tmp, dst)
        except FileExistsError:
            raise BlobExistsError(uri) from None
    finally:
        tmp.unlink(missing_ok=True)


class GcsBlobStore:
    """URIs are `gs://bucket/name`."""

    def __init__(self, project: str | None = None) -> None:
        from google.cloud import storage

        self._client = storage.Client(project=project)

    @staticmethod
    def split(uri: str) -> tuple[str, str]:
        if not uri.startswith("gs://"):
            raise ValueError(f"not a gs:// uri: {uri}")
        bucket, _, name = uri[5:].partition("/")
        return bucket, name

    def list(self, prefix: str) -> Iterator[ObjectInfo]:
        bucket, name = self.split(prefix)
        for blob in self._client.list_blobs(bucket, prefix=name):
            yield ObjectInfo(
                uri=f"gs://{bucket}/{blob.name}",
                size=blob.size or 0,
                generation=blob.generation,
                created=blob.time_created,
                metadata=dict(blob.metadata or {}),
            )

    def read(self, uri: str, generation: int | None = None) -> bytes:
        bucket, name = self.split(uri)
        blob = self._client.bucket(bucket).blob(name, generation=generation)
        return blob.download_as_bytes()

    def write(self, uri: str, data: bytes, *, overwrite: bool, metadata: dict[str, str] | None = None) -> None:
        from google.api_core.exceptions import PreconditionFailed

        bucket, name = self.split(uri)
        blob = self._client.bucket(bucket).blob(name)
        if metadata:
            blob.metadata = metadata
        try:
            blob.upload_from_string(data, if_generation_match=None if overwrite else 0)
        except PreconditionFailed as exc:
            raise BlobExistsError(uri) from exc

    def copy(self, src: str, dst: str, *, overwrite: bool) -> None:
        from google.api_core.exceptions import PreconditionFailed

        src_bucket, src_name = self.split(src)
        dst_bucket, dst_name = self.split(dst)
        source = self._client.bucket(src_bucket).blob(src_name)
        try:
            self._client.bucket(src_bucket).copy_blob(
                source,
                self._client.bucket(dst_bucket),
                dst_name,
                if_generation_match=None if overwrite else 0,
            )
        except PreconditionFailed as exc:
            raise BlobExistsError(dst) from exc

    def exists(self, uri: str) -> bool:
        bucket, name = self.split(uri)
        return bool(self._client.bucket(bucket).blob(name).exists())

    def info(self, uri: str) -> ObjectInfo | None:
        bucket, name = self.split(uri)
        blob = self._client.bucket(bucket).get_blob(name)
        if blob is None:
            return None
        return ObjectInfo(uri, blob.size or 0, blob.generation, blob.time_created, dict(blob.metadata or {}))

    def md5(self, uri: str) -> str | None:
        bucket, name = self.split(uri)
        blob = self._client.bucket(bucket).get_blob(name)
        if blob is None or not blob.md5_hash:
            return None
        return base64.b64decode(blob.md5_hash).hex()

    def upload(self, path: Path, uri: str, *, overwrite: bool) -> None:
        from google.api_core.exceptions import PreconditionFailed

        bucket, name = self.split(uri)
        blob = self._client.bucket(bucket).blob(name)
        try:
            blob.upload_from_filename(str(path), if_generation_match=None if overwrite else 0)
        except PreconditionFailed as exc:
            raise BlobExistsError(uri) from exc


class RoutedStore:
    """Reads from one store, writes to another. Used when sources live in GCS and staging is local or elsewhere."""

    def __init__(self, read_store: BlobStore, write_store: BlobStore) -> None:
        self._read = read_store
        self._write = write_store

    def list(self, prefix: str) -> Iterator[ObjectInfo]:
        return self._read.list(prefix)

    def read(self, uri: str, generation: int | None = None) -> bytes:
        return self._read.read(uri, generation)

    def write(self, uri: str, data: bytes, *, overwrite: bool, metadata: dict[str, str] | None = None) -> None:
        self._write.write(uri, data, overwrite=overwrite, metadata=metadata)

    def copy(self, src: str, dst: str, *, overwrite: bool) -> None:
        self._write.copy(src, dst, overwrite=overwrite)

    def exists(self, uri: str) -> bool:
        return self._write.exists(uri)

    def info(self, uri: str) -> ObjectInfo | None:
        return self._write.info(uri)

    def upload(self, path: Path, uri: str, *, overwrite: bool) -> None:
        self._write.upload(path, uri, overwrite=overwrite)

    def md5(self, uri: str) -> str | None:
        return self._write.md5(uri)


def store_for(uri: str, *, project: str | None = None) -> BlobStore:
    """gs:// URIs get a GCS store; local URIs are absolute paths served from the filesystem root."""
    if uri.startswith("gs://"):
        return GcsBlobStore(project=project)
    return LocalBlobStore("/")


def read_uri(uri: str, *, project: str | None = None) -> bytes:
    if uri.startswith("gs://"):
        return GcsBlobStore(project=project).read(uri)
    return Path(uri).read_bytes()


def write_uri(uri: str, data: bytes, *, overwrite: bool = True, project: str | None = None) -> None:
    if uri.startswith("gs://"):
        GcsBlobStore(project=project).write(uri, data, overwrite=overwrite)
        return
    path = Path(uri)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    _place(Path(tmp_name), path, overwrite, uri)


SYNC_MANIFEST = "_sync_manifest.json"


def sync_prefix(store: BlobStore, prefix: str, local_root: Path) -> list[Path]:
    """Download every object under prefix into local_root, preserving the relative path.

    A local copy is reused only when size and remote generation both match what was recorded at download time.
    """
    base = prefix.rstrip("/") + "/"
    manifest_path = local_root / SYNC_MANIFEST
    recorded: dict[str, dict] = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    out: list[Path] = []
    for info in store.list(base):
        if not info.uri.startswith(base):
            continue
        rel = info.uri[len(base) :]
        target = local_root / rel
        seen = recorded.get(rel)
        if (
            target.is_file()
            and seen is not None
            and seen.get("size") == info.size
            and seen.get("generation") == info.generation
            and target.stat().st_size == info.size
        ):
            out.append(target)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        with os.fdopen(fd, "wb") as fh:
            fh.write(store.read(info.uri, info.generation))
        Path(tmp_name).replace(target)
        recorded[rel] = {"size": info.size, "generation": info.generation}
        out.append(target)
    local_root.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(recorded, indent=1, sort_keys=True))
    return out
