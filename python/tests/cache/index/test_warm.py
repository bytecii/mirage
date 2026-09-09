import pytest
from fakeredis.aioredis import FakeRedis

from mirage.cache.index.config import IndexEntry
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
    await index.put(KEY, entry_for("doc-1"))
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
