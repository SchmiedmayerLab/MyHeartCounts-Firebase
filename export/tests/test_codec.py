# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import zlib

import orjson
import pytest
import zstandard

from mhc_export.io.codec import CodecError, decode, decode_csv, sniff

PAYLOAD = [{"resourceType": "Observation", "id": "a"}, {"resourceType": "Observation", "id": "b"}]
RAW = orjson.dumps(PAYLOAD)


def test_sniff() -> None:
    assert sniff(zstandard.compress(RAW)) == "zstd"
    assert sniff(zlib.compress(RAW)) == "zlib"
    assert sniff(RAW) == "plain"


@pytest.mark.parametrize("blob", [RAW, zlib.compress(RAW), zstandard.compress(RAW)])
def test_decode_all_codecs(blob: bytes) -> None:
    assert decode(blob) == PAYLOAD


def test_decode_zstd_without_content_size_and_multiple_frames() -> None:
    cctx = zstandard.ZstdCompressor(write_content_size=False)
    frames = cctx.compress(RAW[:5]) + cctx.compress(RAW[5:])
    assert decode(frames) == PAYLOAD


def test_decode_rejects_non_array_and_garbage() -> None:
    with pytest.raises(CodecError):
        decode(b'{"a": 1}')
    with pytest.raises(CodecError):
        decode(b"[1, 2]")
    with pytest.raises(CodecError):
        decode(b"\x28\xb5\x2f\xfd" + b"garbage")
    with pytest.raises(CodecError):
        decode(b"not json")


def test_decode_csv() -> None:
    csv_blob = zstandard.compress(
        b"sampleType,sampleId,timestamp\r\nHKQuantityTypeIdentifierHeartRate,ABC,2026-01-01T00:00:00Z\r\n"
    )
    assert decode_csv(csv_blob) == [
        {"sampleType": "HKQuantityTypeIdentifierHeartRate", "sampleId": "ABC", "timestamp": "2026-01-01T00:00:00Z"}
    ]
    assert decode_csv(b"") == []
