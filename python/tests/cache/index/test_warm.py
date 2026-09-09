import os
from uuid import uuid4

import pytest
import pytest_asyncio
from fakeredis.aioredis import FakeRedis
from redis.asyncio import Redis

from mirage.cache.index.config import IndexEntry, LookupStatus
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.cache.index.warm import entry_or_warm
from mirage.utils.errors import enoent, enotdir

KEY = "/owned/notes.json"


def entry_for(entry_id: str) -> IndexEntry:
    return IndexEntry(id=entry_id,
                      name="notes",
                      resource_type="gdocs",
                      vfs_name="notes.json")


@pytest.mark.asyncio
async def test_returns_a_warm_hit_without_listing_the_parent():
    index = RAMIndexCacheStore()
    await index.set_dir("/owned", [("notes.json", entry_for("doc-1"))])
    calls = []

    async def warm():
        calls.append(1)

    got = await entry_or_warm(index, KEY, warm)
    assert got is not None and got.id == "doc-1"
    assert not calls


@pytest.mark.asyncio
async def test_lists_the_parent_once_then_serves_what_it_put_there():
    index = RAMIndexCacheStore()
    calls = []

    async def warm():
        calls.append(1)
        await index.put(KEY, entry_for("doc-2"))

    got = await entry_or_warm(index, KEY, warm)
    assert got is not None and got.id == "doc-2"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_returns_none_when_the_listing_did_not_produce_the_entry():
    index = RAMIndexCacheStore()

    async def warm():
        return None

    assert await entry_or_warm(index, KEY, warm) is None


@pytest.mark.asyncio
async def test_returns_none_without_listing_when_there_is_no_parent():
    index = RAMIndexCacheStore()
    assert await entry_or_warm(index, KEY, None) is None


@pytest.mark.asyncio
async def test_swallows_an_absent_parent_so_the_caller_names_the_operand():
    index = RAMIndexCacheStore()

    async def warm():
        raise enoent("/owned")

    assert await entry_or_warm(index, KEY, warm) is None


@pytest.mark.asyncio
async def test_propagates_an_auth_or_transport_failure():
    index = RAMIndexCacheStore()

    async def warm():
        raise RuntimeError("401 Unauthorized")

    with pytest.raises(RuntimeError, match="401 Unauthorized"):
        await entry_or_warm(index, KEY, warm)


@pytest.mark.asyncio
async def test_propagates_a_non_enoent_fs_error_too():
    index = RAMIndexCacheStore()

    async def warm():
        raise enotdir("/owned")

    with pytest.raises(NotADirectoryError):
        await entry_or_warm(index, KEY, warm)


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize("outcome",
                         ["updated", "deleted", "partial", "absent", "error"])
async def test_retained_entries_require_a_fresh_parent(backend, outcome):
    client = FakeRedis()
    index = RAMIndexCacheStore() if backend == "ram" else RedisIndexCacheStore(
        client=client)
    calls = []

    async def warm():
        calls.append(1)
        if outcome == "absent":
            raise enoent("/owned")
        if outcome == "error":
            raise RuntimeError("unavailable")
        if outcome == "partial":
            await index.put("/owned/other.json", entry_for("other"))
        else:
            rows = [("notes.json",
                     entry_for("new"))] if outcome == "updated" else []
            await index.set_dir("/owned", rows)

    try:
        await index.set_dir("/owned", [("notes.json", entry_for("old"))])
        await index.invalidate()
        assert (await index.get(KEY)).entry.id == "old"
        if outcome == "error":
            with pytest.raises(RuntimeError, match="unavailable"):
                await entry_or_warm(index, KEY, warm)
        else:
            got = await entry_or_warm(index, KEY, warm)
            assert (got.id if got else None) == ("new" if outcome == "updated"
                                                 else None)
        assert calls == [1]
        # A live listing also excludes metadata retained by an earlier refill.
        await index.put(KEY, entry_for("obsolete"))
        await index.set_dir("/owned", [])
        assert await entry_or_warm(index, KEY, warm) is None
        assert calls == [1]
    finally:
        await index.close()
        await client.aclose()


@pytest_asyncio.fixture(params=["ram", "fake", "redis"])
async def orphan_index(request):
    client = None
    if request.param == "ram":
        index = RAMIndexCacheStore()
    else:
        url = os.environ.get("REDIS_URL")
        if request.param == "redis" and not url:
            pytest.skip("REDIS_URL not set")
        client = FakeRedis(decode_responses=True
                           ) if request.param == "fake" else Redis.from_url(
                               url, decode_responses=True)
        index = RedisIndexCacheStore(client=client,
                                     key_prefix=f"orphan:{uuid4()}:")
    try:
        yield index
    finally:
        await index.clear()
        await index.close()
        if client is not None:
            await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("parent_state", ["missing", "invalidated", "expired"])
@pytest.mark.parametrize("outcome", [
    "updated", "renamed", "deleted", "partial", "partial_updated", "absent",
    "error"
])
async def test_orphaned_metadata_requires_a_current_refresh(
        orphan_index, parent_state, outcome):
    index = orphan_index
    calls = []

    async def warm():
        calls.append(1)
        if outcome == "absent":
            raise enoent("/owned")
        if outcome == "error":
            raise RuntimeError("unavailable")
        if outcome == "partial":
            await index.put("/owned/other.json", entry_for("other"))
        elif outcome == "partial_updated":
            await index.put(KEY, entry_for("new"))
        elif outcome == "renamed":
            await index.set_dir("/owned", [("renamed.json", entry_for("new"))])
        else:
            rows = [("notes.json",
                     entry_for("new"))] if outcome == "updated" else []
            await index.set_dir("/owned", rows)

    if parent_state == "expired":
        # This listing never owned the orphan, so invalidate_dir alone
        # cannot remove the stale target before an incomplete refresh.
        await index.set_dir("/owned", [])
    await index.put(KEY, entry_for("old"))
    if parent_state != "missing":
        await index.invalidate()
    assert (await index.get(KEY)).entry.id == "old"
    assert (await
            index.list_dir("/owned")).status == (LookupStatus.EXPIRED
                                                 if parent_state == "expired"
                                                 else LookupStatus.NOT_FOUND)

    for _ in range(2):
        if outcome == "error":
            with pytest.raises(RuntimeError, match="unavailable"):
                await entry_or_warm(index, KEY, warm)
        else:
            got = await entry_or_warm(index, KEY, warm)
            assert (got.id if got else None) == ("new" if outcome in (
                "updated", "partial_updated") else None)
    assert len(calls) == (1 if outcome in ("updated", "renamed",
                                           "deleted") else 2)
