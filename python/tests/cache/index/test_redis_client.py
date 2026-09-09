import asyncio
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, call
from uuid import uuid4

import pytest
import pytest_asyncio
from fakeredis.aioredis import FakeRedis
from redis.asyncio import Redis

from mirage.cache.index.config import IndexEntry, LookupStatus
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.cache.index.warm import entry_or_warm


@pytest_asyncio.fixture(params=["fake", "redis"])
async def rolling_client(request):
    url = os.environ.get("REDIS_URL")
    if request.param == "redis" and not url:
        pytest.skip("REDIS_URL not set")
    client = FakeRedis(
        decode_responses=True) if request.param == "fake" else Redis.from_url(
            url, decode_responses=True)
    prefix = f"rolling:{uuid4()}:"
    try:
        yield client, prefix
    finally:
        keys = [key async for key in client.scan_iter(match=f"{prefix}*")]
        if keys:
            await client.delete(*keys)
        await client.aclose()


async def legacy_clear(client: Redis, prefix: str) -> None:
    # The unmodified v1 implementation scans these two namespaces verbatim.
    for namespace in ("mirage:idx:entry:", "mirage:idx:children:"):
        cursor = 0
        while True:
            cursor, keys = await client.scan(cursor,
                                             match=f"{prefix}{namespace}*",
                                             count=500)
            if keys:
                await client.delete(*keys)
            if cursor == 0:
                break


@pytest.fixture
def client():
    value = MagicMock()
    value.scan = AsyncMock(return_value=(
        0,
        [b"test:mirage:idx:entry:v2:/folder/a.txt"],
    ))
    value.mget = AsyncMock(return_value=[
        b'{"entries":["/folder/a.txt"],"expires_at":4102444800,"generation":"g:d"}',
        b'g', b'd'
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
    client.mget.assert_awaited_once_with(
        "mirage:idx:directory:v2:/folder", "mirage:idx:children:!generation",
        "mirage:idx:children:!generation:/folder")


@pytest.mark.asyncio
async def test_invalidate_dir_decodes_child_paths(client):
    store = RedisIndexCacheStore(client=client)
    client.get.return_value = (
        b'{"entries":["/folder/a.txt"],"expires_at":4102444800,'
        b'"generation":"g"}')
    await store.invalidate_dir("/folder")
    pipe = client.pipeline.return_value
    assert pipe.delete.call_args_list == [
        call("mirage:idx:entry:v2:/folder/a.txt"),
        call("mirage:idx:directory:v2:/folder"),
        call("mirage:idx:children:!generation:/folder"),
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
    client.mget.return_value = [b"d"]
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
    client.mget.return_value = [b"d"]
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
    client.mget.return_value = [b"d"]
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
        await client.delete("mirage:idx:children:!generation")
        assert (await store.list_dir("/old")).status == LookupStatus.EXPIRED
        await store.set_dir("/new", [])
        assert (await store.list_dir("/new")).entries == []
        assert (await store.list_dir("/old")).status == LookupStatus.EXPIRED
    finally:
        await store.close()
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("empty", [False, True])
@pytest.mark.parametrize("seed", [False, True])
async def test_legacy_global_clear_expires_versioned_listings(
        rolling_client, empty, seed):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    row = IndexEntry(id="old", name="old.txt", resource_type="file")
    deadline = datetime.now(timezone.utc) + timedelta(days=365)
    rows = [] if empty else [("old.txt", row)]
    try:
        if seed:
            store.seed({
                f"/repo/{name}": entry
                for name, entry in rows
            }, {"/repo": [f"/repo/{name}" for name, _ in rows]}, deadline)
        else:
            await store.set_dir("/repo", rows, expired_at=deadline)
        assert (await store.list_dir("/repo")).entries == [
            f"/repo/{name}" for name, _ in rows
        ]

        await legacy_clear(client, prefix)
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/other", [])
        assert (await store.list_dir("/other")).entries == []
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/repo", [("new.txt", row)])
        assert (await store.list_dir("/repo")).entries == ["/repo/new.txt"]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_new_global_invalidation_evicts_only_legacy_payloads(
        rolling_client):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    row = IndexEntry(id="old", name="a.txt", resource_type="file")
    legacy_entry = f"{prefix}mirage:idx:entry:/repo/a.txt"
    legacy_children = f"{prefix}mirage:idx:children:/repo"
    neighbor = f"{prefix}neighbor:mirage:idx:children:/repo"
    try:
        await client.set(legacy_entry, row.model_dump_json())
        await client.rpush(legacy_children, "/repo/a.txt")
        await client.rpush(neighbor, "/repo/a.txt")
        await store.set_dir("/repo", [("a.txt", row)])
        retained = (await store.get("/repo/a.txt")).entry
        await store.invalidate()

        assert await client.get(legacy_entry) is None
        assert await client.lrange(legacy_children, 0, -1) == []
        assert await client.lrange(neighbor, 0, -1) == ["/repo/a.txt"]
        assert (await store.get("/repo/a.txt")).entry == retained
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        assert await client.get(f"{prefix}mirage:idx:children:!generation")
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_legacy_clear_between_generation_and_seed_commit_stays_expired(
        rolling_client, monkeypatch):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original_pipeline = client.pipeline

    def delayed_pipeline():
        pipe = original_pipeline()
        execute = pipe.execute

        async def execute_after_clear():
            await legacy_clear(client, prefix)
            return await execute()

        pipe.execute = execute_after_clear
        return pipe

    try:
        monkeypatch.setattr(client, "pipeline", delayed_pipeline)
        store.seed({}, {"/repo": []},
                   datetime.now(timezone.utc) + timedelta(days=365))
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        monkeypatch.setattr(client, "pipeline", original_pipeline)
        await store.set_dir("/other", [])
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
    finally:
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation",
                         ["invalidate_dir", "invalidate_prefix", "clear"])
async def test_new_scoped_invalidations_remove_legacy_rows(
        rolling_client, operation):
    client, prefix = rolling_client
    scoped = prefix + "literal[1]:"
    other = prefix + "literal1:"
    store = RedisIndexCacheStore(client=client, key_prefix=scoped)
    row = IndexEntry(id="old", name="a.txt", resource_type="file")
    try:
        for namespace in (scoped, other):
            for directory in ("/repo[1]", "/repo1"):
                await client.set(
                    f"{namespace}mirage:idx:entry:{directory}/a.txt",
                    row.model_dump_json())
                await client.rpush(
                    f"{namespace}mirage:idx:children:{directory}",
                    f"{directory}/a.txt")
        await store.set_dir("/repo[1]", [("a.txt", row)])
        await store.set_dir("/repo1", [("a.txt", row)])
        if operation == "clear":
            await store.clear()
        else:
            await getattr(store, operation)("/repo[1]")
        assert await client.get(f"{scoped}mirage:idx:entry:/repo[1]/a.txt"
                                ) is None
        assert await client.lrange(f"{scoped}mirage:idx:children:/repo[1]", 0,
                                   -1) == []
        assert await client.lrange(f"{other}mirage:idx:children:/repo[1]", 0,
                                   -1) == ["/repo[1]/a.txt"]
        if operation != "clear":
            assert await client.lrange(f"{scoped}mirage:idx:children:/repo1",
                                       0, -1) == ["/repo1/a.txt"]
            assert (await store.list_dir("/repo1")).entries == ["/repo1/a.txt"]
    finally:
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    ["invalidate", "invalidate_dir", "invalidate_prefix", "clear"])
@pytest.mark.parametrize("writer_version", [0, 1])
async def test_invalidation_signals_cross_payload_versions(
        rolling_client, monkeypatch, operation, writer_version):
    client, prefix = rolling_client
    stores = [
        RedisIndexCacheStore(client=client, key_prefix=prefix)
        for _ in range(2)
    ]
    # A future payload format still uses the same invalidation protocol.
    monkeypatch.setattr(stores[1], "_entry_prefix",
                        f"{prefix}mirage:idx:entry:v3:")
    monkeypatch.setattr(stores[1], "_children_prefix",
                        f"{prefix}mirage:idx:directory:v3:")
    writer, reader = stores[writer_version], stores[1 - writer_version]
    row = IndexEntry(id="old", name="a.txt", resource_type="file")
    deadline = datetime.now(timezone.utc) + timedelta(days=365)
    try:
        for store in stores:
            for path in ("/repo", "/repo/sub", "/repository"):
                await store.set_dir(path, [("a.txt", row)],
                                    expired_at=deadline)
        if operation in ("invalidate", "clear"):
            await getattr(writer, operation)()
        else:
            await getattr(writer, operation)("/repo")

        assert (await reader.list_dir("/repo")).status == LookupStatus.EXPIRED
        child = await reader.list_dir("/repo/sub")
        sibling = await reader.list_dir("/repository")
        if operation == "invalidate_dir":
            assert child.entries == ["/repo/sub/a.txt"]
        else:
            assert child.status == LookupStatus.EXPIRED
        if operation in ("invalidate_dir", "invalidate_prefix"):
            assert sibling.entries == ["/repository/a.txt"]
        else:
            assert sibling.status == LookupStatus.EXPIRED

        await writer.set_dir("/repo", [])
        assert (await reader.list_dir("/repo")).status == LookupStatus.EXPIRED
        await reader.set_dir("/repo", [("new.txt", row)])
        assert (await reader.list_dir("/repo")).entries == ["/repo/new.txt"]
    finally:
        for store in stores:
            await store.close()


@pytest.mark.asyncio
async def test_evicted_directory_token_cannot_revive_other_format(
        rolling_client):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    try:
        await store.set_dir("/repo", [])
        payload_key = f"{prefix}mirage:idx:directory:v2:/repo"
        original = await client.get(payload_key)
        await client.delete(f"{prefix}mirage:idx:children:!generation:/repo")
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/repo", [])
        assert (await store.list_dir("/repo")).entries == []
        await client.set(payload_key, original)
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_seed_directory_tokens_use_bounded_round_trips(
        rolling_client, monkeypatch):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    get = MagicMock(wraps=client.get)
    mget = MagicMock(wraps=client.mget)
    pipeline = MagicMock(wraps=client.pipeline)
    monkeypatch.setattr(client, "get", get)
    monkeypatch.setattr(client, "mget", mget)
    monkeypatch.setattr(client, "pipeline", pipeline)
    try:
        store.seed({}, {f"/repo/{i}": []
                        for i in range(1000)},
                   datetime.now(timezone.utc) + timedelta(days=365))
        assert (await store.list_dir("/repo/0")).entries == []
        assert get.call_count == 1
        assert mget.call_count == 2
        assert pipeline.call_count == 2
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_batched_initialization_preserves_observed_tokens(
        rolling_client, monkeypatch):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    try:
        await store.set_dir("/present", [])
        original_pipeline = client.pipeline

        def invalidate_during_pipeline():
            pipe = original_pipeline()
            execute = pipe.execute

            async def execute_after_invalidation():
                await client.set(
                    f"{prefix}mirage:idx:children:!generation:/present",
                    "replacement")
                return await execute()

            pipe.execute = execute_after_invalidation
            return pipe

        monkeypatch.setattr(client, "pipeline", invalidate_during_pipeline)
        store.seed({}, {
            "/present": [],
            "/missing": []
        },
                   datetime.now(timezone.utc) + timedelta(days=365))
        assert (await
                store.list_dir("/present")).status == LookupStatus.EXPIRED
        assert (await store.list_dir("/missing")).entries == []
    finally:
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("timing", ["before", "after"])
@pytest.mark.parametrize("scope", ["global", "directory"])
async def test_scalar_initialization_does_not_adopt_replacement_tokens(
        rolling_client, monkeypatch, timing, scope):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    writer = RedisIndexCacheStore(client=client, key_prefix=prefix)
    generation_key = f"{prefix}mirage:idx:children:!generation"
    target = generation_key if scope == "global" else f"{generation_key}:/repo"
    original_set = client.set
    fresh = IndexEntry(id="new", name="new.txt", resource_type="file")
    stale = IndexEntry(id="old", name="old.txt", resource_type="file")

    async def refill():
        await writer.set_dir("/repo", [("new.txt", fresh)])
        if scope == "global":
            await writer.invalidate()
        else:
            await writer.invalidate_dir("/repo")
        await writer.set_dir("/repo", [("new.txt", fresh)])

    async def set_during_refill(key, value, **options):
        if key != target or not options.get("nx"):
            return await original_set(key, value, **options)
        monkeypatch.setattr(client, "set", original_set)
        if timing == "before":
            await refill()
        result = await original_set(key, value, **options)
        if timing == "after":
            await refill()
        return result

    try:
        monkeypatch.setattr(client, "set", set_during_refill)
        await store.set_dir("/repo", [("old.txt", stale)],
                            expired_at=datetime.now(timezone.utc) +
                            timedelta(days=365))
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/repo", [("new.txt", fresh)])
        assert (await store.list_dir("/repo")).entries == ["/repo/new.txt"]
    finally:
        await store.close()
        await writer.close()


@pytest.mark.asyncio
async def test_parallel_cold_directory_writes_remain_fresh(rolling_client):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    paths = [f"/repo/{i}" for i in range(20)]
    try:
        await asyncio.gather(*(store.set_dir(path, []) for path in paths))
        for path in paths:
            assert (await store.list_dir(path)).entries == []
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_shared_generation_failure_can_retry(rolling_client,
                                                   monkeypatch):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original_get = client.get

    async def fail(key):
        await asyncio.sleep(0)
        raise ConnectionError(key)

    try:
        monkeypatch.setattr(client, "get", fail)
        results = await asyncio.gather(store.set_dir("/a", []),
                                       store.set_dir("/b", []),
                                       return_exceptions=True)
        assert all(isinstance(result, ConnectionError) for result in results)
        monkeypatch.setattr(client, "get", original_get)
        await asyncio.gather(store.set_dir("/a", []), store.set_dir("/b", []))
        assert (await store.list_dir("/a")).entries == []
        assert (await store.list_dir("/b")).entries == []
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_cancelled_generation_waiter_does_not_cancel_peer(
        rolling_client, monkeypatch):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original_get = client.get
    started = asyncio.Event()
    release = asyncio.Event()

    async def delayed_get(key):
        started.set()
        await release.wait()
        return await original_get(key)

    try:
        monkeypatch.setattr(client, "get", delayed_get)
        cancelled = asyncio.create_task(store.set_dir("/cancelled", []))
        survivor = asyncio.create_task(store.set_dir("/survivor", []))
        await started.wait()
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        release.set()
        await survivor
        assert (await store.list_dir("/survivor")).entries == []
    finally:
        release.set()
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("timing", ["before", "after"])
async def test_seed_initialization_does_not_adopt_replacement_tokens(
        rolling_client, monkeypatch, timing):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    writer = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original_pipeline = client.pipeline
    fresh = IndexEntry(id="new", name="new.txt", resource_type="file")

    async def refill():
        await writer.set_dir("/repo", [("new.txt", fresh)])
        await writer.invalidate_dir("/repo")
        await writer.set_dir("/repo", [("new.txt", fresh)])

    def pipeline_during_refill():
        monkeypatch.setattr(client, "pipeline", original_pipeline)
        pipe = original_pipeline()
        execute = pipe.execute

        async def execute_during_refill():
            if timing == "before":
                await refill()
            result = await execute()
            if timing == "after":
                await refill()
            return result

        pipe.execute = execute_during_refill
        return pipe

    try:
        monkeypatch.setattr(client, "pipeline", pipeline_during_refill)
        store.seed(
            {
                "/repo/old.txt":
                IndexEntry(id="old", name="old.txt", resource_type="file")
            }, {"/repo": ["/repo/old.txt"]},
            datetime.now(timezone.utc) + timedelta(days=365))
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/repo", [("new.txt", fresh)])
        assert (await store.list_dir("/repo")).entries == ["/repo/new.txt"]
    finally:
        await store.close()
        await writer.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("invalidate", [False, True])
@pytest.mark.parametrize("change", ["updated", "renamed", "deleted"])
async def test_legacy_entries_are_cold_before_warming(change, invalidate):
    client = FakeRedis()
    store = RedisIndexCacheStore(client=client, key_prefix="upgrade:")
    key = "/folder/f.txt"
    old = IndexEntry(id="old", name="f.txt", resource_type="file")
    name = "g.txt" if change == "renamed" else "f.txt"
    fresh = IndexEntry(id="new", name=name, resource_type="file")
    rows = [] if change == "deleted" else [(name, fresh)]

    async def refresh():
        await store.set_dir("/folder", rows)

    warm = AsyncMock(side_effect=refresh)
    try:
        await client.set(f"upgrade:mirage:idx:entry:{key}",
                         old.model_dump_json())
        await client.rpush("upgrade:mirage:idx:children:/folder", key)
        if invalidate:
            await store.invalidate()
        assert (await
                store.list_dir("/folder")).status == LookupStatus.NOT_FOUND
        assert (await store.get(key)).status == LookupStatus.NOT_FOUND
        assert await store.entries() == {}

        result = await entry_or_warm(store, key, warm)
        if change == "updated":
            assert result is not None and result.id == "new"
        else:
            assert result is None
        warm.assert_awaited_once()
        assert await entry_or_warm(store, key, warm) == result
        warm.assert_awaited_once()
        assert set(await
                   store.entries()) == {f"/folder/{name}"
                                        for name, _ in rows}
    finally:
        await store.close()
        await client.aclose()
