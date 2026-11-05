# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from pathlib import Path

import pytest

from mhc_export.io.blobstore import BlobExistsError, GcsBlobStore, LocalBlobStore


def test_local_roundtrip_and_overwrite_rules(tmp_path: Path) -> None:
    store = LocalBlobStore(tmp_path)
    store.write("a/b/c.bin", b"1", overwrite=False)
    assert store.read("a/b/c.bin") == b"1"
    with pytest.raises(BlobExistsError):
        store.write("a/b/c.bin", b"2", overwrite=False)
    store.write("a/b/c.bin", b"2", overwrite=True)
    assert store.read("a/b/c.bin") == b"2"
    store.copy("a/b/c.bin", "x/y.bin", overwrite=False)
    with pytest.raises(BlobExistsError):
        store.copy("a/b/c.bin", "x/y.bin", overwrite=False)
    assert store.exists("x/y.bin") and not store.exists("x/z.bin")
    listed = list(store.list("a"))
    assert [o.uri for o in listed] == [str(tmp_path.resolve() / "a/b/c.bin")] and listed[0].size == 1
    assert store.read(listed[0].uri) == b"2"


def test_local_rejects_escape(tmp_path: Path) -> None:
    store = LocalBlobStore(tmp_path)
    with pytest.raises(ValueError):
        store.read("../etc/passwd")


def test_gcs_split() -> None:
    assert GcsBlobStore.split("gs://b/x/y.z") == ("b", "x/y.z")
    with pytest.raises(ValueError):
        GcsBlobStore.split("s3://b/x")
