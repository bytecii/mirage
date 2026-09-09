import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, call

import pytest

from mirage.cache.index.config import IndexEntry
from mirage.cache.index.redis import RedisIndexCacheStore

# What the server hands back: a listing document written far in the
# future, and one entry, both as bytes (a client without decode_responses).
LISTING = json.dumps({
    "children": ["/folder/a.txt"],
    "written_at": 1.0,
    "expires_at": 1e12,
}).encode()
ENTRY = b'{"id":"a","name":"a.txt","resource_type":"file"}'


async def _stored_value(key: str | bytes) -> bytes:
    text = key.decode() if isinstance(key, bytes) else key
    return LISTING if "idx:children:" in text else ENTRY


@pytest.fixture
def client():
    value = MagicMock()
    value.mget = AsyncMock(return_value=[LISTING, None])
    value.scan = AsyncMock(return_value=(
        0,
        [b"test:mirage:idx:entry:/folder/a.txt"],
    ))
    value.get = AsyncMock(side_effect=_stored_value)
    pipe = MagicMock()
    pipe.execute = AsyncMock()
    value.pipeline.return_value = pipe
    return value


@pytest.mark.asyncio
async def test_list_dir_decodes_injected_client_values(client):
    store = RedisIndexCacheStore(client=client)
    result = await store.list_dir("/folder")
    assert result.entries == ["/folder/a.txt"]


# One MGET answers all three states (missing, expired, listed); the old
# EXISTS + TTL + LRANGE triple was three round trips for one fact.
@pytest.mark.asyncio
async def test_list_dir_is_one_round_trip(client):
    store = RedisIndexCacheStore(client=client)
    await store.list_dir("/folder")
    client.mget.assert_awaited_once_with([
        "mirage:idx:children:/folder",
        "mirage:idx:invalidated_at",
    ])
    client.get.assert_not_called()


@pytest.mark.asyncio
async def test_close_flushes_a_pending_seed(client):
    store = RedisIndexCacheStore(client=client)
    store.seed(
        {
            "/folder/a.txt": IndexEntry(
                id="a", name="a.txt", resource_type="file")
        },
        {"/folder": ["/folder/a.txt"]},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )
    await store.close()
    client.pipeline.return_value.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_invalidate_dir_decodes_child_paths(client):
    store = RedisIndexCacheStore(client=client)
    await store.invalidate_dir("/folder")
    pipe = client.pipeline.return_value
    assert pipe.delete.call_args_list == [
        call("mirage:idx:entry:/folder/a.txt"),
        call("mirage:idx:children:/folder"),
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

    await store.get("/folder/a.txt")

    client.pipeline.return_value.execute.assert_awaited_once()
