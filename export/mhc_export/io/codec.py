# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from __future__ import annotations

import csv
import io
import zlib
from typing import Any, Literal

import orjson
import zstandard

Codec = Literal["zstd", "zlib", "plain"]
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


class CodecError(ValueError):
    pass


def sniff(blob: bytes) -> Codec:
    if blob[:4] == ZSTD_MAGIC:
        return "zstd"
    if len(blob) >= 2 and blob[0] == 0x78 and ((blob[0] << 8) | blob[1]) % 31 == 0:
        return "zlib"
    return "plain"


def decompress(blob: bytes) -> bytes:
    codec = sniff(blob)
    try:
        if codec == "zstd":
            reader = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(blob), read_across_frames=True)
            return reader.read()
        if codec == "zlib":
            return zlib.decompress(blob)
    except Exception as exc:
        raise CodecError(f"{codec} decompression failed: {exc}") from exc
    return blob


def decode(blob: bytes) -> list[dict[str, Any]]:
    data = decompress(blob)
    try:
        parsed = orjson.loads(data)
    except orjson.JSONDecodeError as exc:
        raise CodecError(f"invalid JSON: {exc}") from exc
    if not isinstance(parsed, list):
        raise CodecError("expected a JSON array")
    if not all(isinstance(item, dict) for item in parsed):
        raise CodecError("expected a JSON array of objects")
    return parsed


def decode_csv(blob: bytes) -> list[dict[str, str]]:
    data = decompress(blob)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CodecError(f"CSV is not UTF-8: {exc}") from exc
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        return []
    return [dict(row) for row in reader]
