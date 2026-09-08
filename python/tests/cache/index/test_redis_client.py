import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, call

import pytest
from fakeredis.aioredis import FakeRedis

from mirage.cache.index.config import IndexEntry, LookupStatus
from mirage.cache.index.redis import RedisIndexCacheStore


@pytest.fixture
def client():
    value = MagicMock()
    value.scan = AsyncMock(return_value=(
        0,
        [b"test:mirage:idx:entry:/folder/a.txt"],
    ))
    value.mget = AsyncMock(return_value=[
        b'{"entries":["/folder/a.txt"],"expires_at":4102444800,"generation":"g"}',
        b'g'
    ])
    value.set = AsyncMock()
    value.delete = AsyncMock()
    value.get = AsyncMock(
        return_value=(b'{"id":"a","name":"a.txt","resource_type":"file"}'))
    pipe = MagicMock()
    pipe.execute = AsyncMock()
    value.pipeline.return_value = pipe
    return value


@pytest.mark.asyncio
async def test_list_dir_decodes_injected_client_values(client):
    store = RedisIndexCacheStore(client=client)
    result = await store.list_dir("/folder")
    assert result.entries == ["/folder/a.txt"]
    client.mget.assert_awaited_once()


@pytest.mark.asyncio
async def test_invalidate_dir_decodes_child_paths(client):
    store = RedisIndexCacheStore(client=client)
    client.get.return_value = (
        b'{"entries":["/folder/a.txt"],"expires_at":4102444800,'
        b'"generation":"g"}')
    await store.invalidate_dir("/folder")
    pipe = client.pipeline.return_value
    assert pipe.delete.call_args_list == [
        call("mirage:idx:entry:/folder/a.txt"),
        call("mirage:idx:directory:v2:/folder"),
    ]


@pytest.mark.asyncio
async def test_entries_decodes_keys_and_json(client):
    store = RedisIndexCacheStore(client=client, key_prefix="test:")
    entries = await store.entries()
    assert entries["/folder/a.txt"].id == "a"


@pytest.mark.asyncio
async def test_falsey_injected_client_is_used_and_not_closed(client):
    client.__bool__.return_value = False
    store = RedisIndexCacheStore(client=client)

    await store.get("/folder/a.txt")
    await store.close()
    await store.close()

    client.get.assert_awaited_once()
    client.aclose.assert_not_called()


@pytest.mark.asyncio
async def test_seed_flushes_before_first_lookup(client):
    store = RedisIndexCacheStore(client=client)
    store.seed(
        {
            "/folder/a.txt": IndexEntry(
                id="a", name="a.txt", resource_type="file")
        },
        {"/folder": ["/folder/a.txt"]},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )

    client.get.return_value = None
    await store.get("/folder/a.txt")

    client.pipeline.return_value.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_seed_flush_remains_retryable(client):
    client.get.return_value = b"g"
    store = RedisIndexCacheStore(client=client)
    store.seed({"/a": IndexEntry(id="a", name="a", resource_type="file")},
               {"/": ["/a"]},
               datetime.now(timezone.utc) + timedelta(hours=1))
    pipe = client.pipeline.return_value
    pipe.execute.side_effect = [ConnectionError("retry"), None]
    with pytest.raises(ConnectionError, match="retry"):
        await store.close()
    await store.close()
    assert pipe.execute.await_count == 2
    assert pipe.set.call_args_list[:2] == pipe.set.call_args_list[2:]


@pytest.mark.asyncio
async def test_concurrent_readers_flush_each_seed_once(client):
    client.get.return_value = None
    store = RedisIndexCacheStore(client=client)
    store.seed({"/a": IndexEntry(id="a", name="a", resource_type="file")},
               {"/": ["/a"]},
               datetime.now(timezone.utc) + timedelta(hours=1))
    await asyncio.gather(store.get("/a"), store.get("/a"))
    client.pipeline.return_value.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_evicted_generation_cannot_revive_invalidated_listing():
    client = FakeRedis()
    store = RedisIndexCacheStore(client=client)
    try:
        await store.set_dir("/old", [])
        await store.invalidate()
        await client.delete("mirage:idx:generation")
        assert (await store.list_dir("/old")).status == LookupStatus.EXPIRED
        await store.set_dir("/new", [])
        assert (await store.list_dir("/new")).entries == []
        assert (await store.list_dir("/old")).status == LookupStatus.EXPIRED
    finally:
        await store.close()
        await client.aclose()
