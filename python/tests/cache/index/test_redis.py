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

import os
import time
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from mirage.cache.index import LookupStatus
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.types import FileStat, FileType

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def store(redis_prefix):
    s = RedisIndexCacheStore(ttl=60, url=REDIS_URL, key_prefix=redis_prefix)
    await s.clear()
    yield s
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_list_dir_expired(store):
    entries = [
        (
            "file.txt",
            FileStat(name="F", type=FileType.FILE, fingerprint="f"),
        ),
    ]
    past = datetime.now(timezone.utc) + timedelta(seconds=1)
    await store.set_dir("/dir", entries, expired_at=past)
    time.sleep(1.5)
    result = await store.list_dir("/dir")
    assert result.status == LookupStatus.EXPIRED


@pytest.mark.asyncio
async def test_key_prefix_isolation(redis_prefix):
    s1 = RedisIndexCacheStore(
        ttl=60, url=REDIS_URL, key_prefix=f"{redis_prefix}ns1:"
    )
    s2 = RedisIndexCacheStore(
        ttl=60, url=REDIS_URL, key_prefix=f"{redis_prefix}ns2:"
    )
    await s1.clear()
    await s2.clear()
    await s1.put(
        "/shared", FileStat(name="a", type=FileType.FILE, fingerprint="a")
    )
    assert (await s2.get("/shared")).status == LookupStatus.NOT_FOUND
    assert (await s1.get("/shared")).entry is not None
    await s1.clear()
    await s2.clear()
    await s1.close()
    await s2.close()


# The one wire format: what pydantic writes for a FileStat, snake_case and
# every field. `redis.test.ts` pins the same literal, so a row either
# language writes is one the other reads.
ENTRY_WIRE = (
    '{"name":"a.txt","size":6,"modified":"2026-01-01T00:00:00Z",'
    '"fingerprint":"/a.txt","revision":null,"type":"file","content":null,'
    '"mode":null,"uid":null,"gid":null,"atime":null,"ctime":null,'
    '"birthtime":null,"dev":null,"extra":{}}'
)


@pytest.mark.asyncio
async def test_entry_wire_format_is_the_shared_json(store):
    await store.put(
        "/a.txt",
        FileStat(
            name="a.txt",
            type=FileType.FILE,
            size=6,
            modified="2026-01-01T00:00:00Z",
            fingerprint="/a.txt",
        ),
    )
    assert await store._client.get(store._entry_key("/a.txt")) == ENTRY_WIRE
