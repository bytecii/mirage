# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio

from mirage.cache.index import (IndexCacheStore, IndexEntry, LookupStatus,
                                RAMIndexCacheStore, RedisIndexCacheStore)

REDIS_URL = os.environ.get("REDIS_URL", "")
CONTRACT_STORES = [
    "ram",
    pytest.param("redis",
                 marks=pytest.mark.skipif(not REDIS_URL,
                                          reason="REDIS_URL not set")),
]


@pytest.fixture
def store():
    return RAMIndexCacheStore(ttl=60)


@pytest.fixture
def entry():
    return IndexEntry(
        id="file1",
        name="Test File",
        resource_type="text/plain",
        remote_time="2026-04-01T00:00:00.000Z",
        vfs_name="test_file.txt",
    )


@pytest.mark.asyncio
async def test_put_and_get(store, entry):
    await store.put("/folder/test_file.txt", entry)
    result = await store.get("/folder/test_file.txt")
    assert result.entry is not None
    assert result.entry.id == "file1"
    assert result.entry.name == "Test File"


@pytest.mark.asyncio
async def test_put_sets_index_time(store, entry):
    await store.put("/folder/test_file.txt", entry)
    result = await store.get("/folder/test_file.txt")
    assert result.entry is not None
    assert result.entry.index_time != ""


@pytest.mark.asyncio
async def test_get_not_found(store):
    result = await store.get("/nonexistent/file.txt")
    assert result.status == LookupStatus.NOT_FOUND
    assert result.entry is None


@pytest.mark.asyncio
async def test_list_dir_not_found(store):
    result = await store.list_dir("/some_dir")
    assert result.status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_set_dir_and_list(store):
    entries = [
        ("a.txt",
         IndexEntry(
             id="a",
             name="A",
             resource_type="text/plain",
             vfs_name="a.txt",
         )),
        ("b.txt",
         IndexEntry(
             id="b",
             name="B",
             resource_type="text/plain",
             vfs_name="b.txt",
         )),
    ]
    await store.set_dir("/mydir", entries)
    result = await store.list_dir("/mydir")
    assert result.status is None
    assert sorted(result.entries) == ["/mydir/a.txt", "/mydir/b.txt"]


@pytest.mark.asyncio
async def test_set_dir_root(store):
    entries = [
        ("top.txt",
         IndexEntry(
             id="t",
             name="T",
             resource_type="text/plain",
             vfs_name="top.txt",
         )),
    ]
    await store.set_dir("/", entries)
    result = await store.list_dir("/")
    assert result.status is None
    assert result.entries == ["/top.txt"]


@pytest.mark.asyncio
async def test_list_dir_expired(store):
    entries = [
        ("file.txt",
         IndexEntry(
             id="f",
             name="F",
             resource_type="text/plain",
             vfs_name="file.txt",
         )),
    ]
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    await store.set_dir("/dir", entries, expired_at=past)
    result = await store.list_dir("/dir")
    assert result.status == LookupStatus.EXPIRED


@pytest.mark.asyncio
async def test_list_dir_fresh(store):
    entries = [
        ("file.txt",
         IndexEntry(
             id="f",
             name="F",
             resource_type="text/plain",
             vfs_name="file.txt",
         )),
    ]
    future = datetime.now(timezone.utc) + timedelta(seconds=3600)
    await store.set_dir("/dir", entries, expired_at=future)
    result = await store.list_dir("/dir")
    assert result.status is None
    assert result.entries == ["/dir/file.txt"]


@pytest.mark.asyncio
async def test_clear(store, entry):
    await store.put("/folder/test.txt", entry)
    await store.set_dir("/folder", [("test.txt", entry)])

    await store.clear()
    result = await store.get("/folder/test.txt")
    assert result.status == LookupStatus.NOT_FOUND
    result = await store.list_dir("/folder")
    assert result.status == LookupStatus.NOT_FOUND


# The contract every store answers identically; only the storage differs.
# `test_ram.py` alone covered the empty listing, which is how the Redis store
# drifted: Redis has no empty list, so a directory with no children was
# never recorded as listed (#1008); a listing past its TTL read as NOT_FOUND
# rather than EXPIRED, and one written already expired served for up to a
# second (#1022). TypeScript mirrors this file in `store.test.ts`, minus the
# seed cases, since its base store has no `seed`.
async def _contract_store(kind: str) -> IndexCacheStore:
    if kind == "ram":
        return RAMIndexCacheStore(ttl=60)
    store = RedisIndexCacheStore(ttl=60,
                                 url=REDIS_URL,
                                 key_prefix=f"contract:{uuid4()}:")
    await store.clear()
    return store


@pytest_asyncio.fixture(params=CONTRACT_STORES)
async def any_store(request):
    store = await _contract_store(request.param)
    yield store
    await store.clear()
    await store.close()


@pytest.mark.asyncio
async def test_contract_empty_listing_is_listed(any_store):
    await any_store.set_dir("/empty", [])
    result = await any_store.list_dir("/empty")
    assert result.status is None
    assert result.entries == []


@pytest.mark.asyncio
async def test_contract_unlisted_directory_is_not_found(any_store):
    assert (await
            any_store.list_dir("/never")).status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_contract_past_expiry_is_expired_at_once(any_store, entry):
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    await any_store.set_dir("/d", [("f.txt", entry)], expired_at=past)
    assert (await any_store.list_dir("/d")).status == LookupStatus.EXPIRED
    assert (await any_store.get("/d/f.txt")).entry is not None


@pytest.mark.asyncio
async def test_contract_natural_expiry_is_expired_not_missing(
        any_store, entry):
    soon = datetime.now(timezone.utc) + timedelta(milliseconds=200)
    await any_store.set_dir("/d", [("f.txt", entry)], expired_at=soon)
    assert (await any_store.list_dir("/d")).entries == ["/d/f.txt"]
    await asyncio.sleep(0.3)
    assert (await any_store.list_dir("/d")).status == LookupStatus.EXPIRED


@pytest.mark.asyncio
async def test_contract_invalidate_expires_without_discarding(
        any_store, entry):
    await any_store.set_dir("/d", [("f.txt", entry)])
    await any_store.invalidate()
    assert (await any_store.list_dir("/d")).status == LookupStatus.EXPIRED
    assert (await any_store.get("/d/f.txt")).entry is not None
    assert (await
            any_store.list_dir("/never")).status == LookupStatus.NOT_FOUND
    await any_store.set_dir("/d", [("g.txt", entry)])
    assert (await any_store.list_dir("/d")).entries == ["/d/g.txt"]


@pytest.mark.asyncio
async def test_contract_seed_then_invalidate_is_expired(any_store, entry):
    later = datetime.now(timezone.utc) + timedelta(hours=1)
    any_store.seed({"/d/f.txt": entry}, {
        "/d": ["/d/f.txt"],
        "/d/empty": []
    }, later)
    assert (await any_store.list_dir("/d")).entries == ["/d/f.txt"]
    assert (await any_store.list_dir("/d/empty")).entries == []
    await any_store.invalidate()
    assert (await any_store.list_dir("/d")).status == LookupStatus.EXPIRED
    assert (await any_store.get("/d/f.txt")).entry is not None


@pytest.mark.asyncio
async def test_contract_invalidate_dir_forgets_listing_and_children(
        any_store, entry):
    await any_store.set_dir("/d", [("f.txt", entry)])
    await any_store.invalidate_dir("/d")
    assert (await any_store.list_dir("/d")).status == LookupStatus.NOT_FOUND
    assert (await any_store.get("/d/f.txt")).status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_contract_clear_forgets_the_invalidation_too(any_store, entry):
    await any_store.set_dir("/d", [("f.txt", entry)])
    await any_store.invalidate()
    await any_store.clear()
    assert (await any_store.list_dir("/d")).status == LookupStatus.NOT_FOUND
    await any_store.set_dir("/d", [("f.txt", entry)])
    assert (await any_store.list_dir("/d")).entries == ["/d/f.txt"]
