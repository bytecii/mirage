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
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.object_store.du import make_du_size
from mirage.core.object_store.find import make_find
from mirage.core.object_store.readdir import make_readdir
from mirage.core.object_store.stat import make_stat
from mirage.types import FileType
from tests.core.object_store.conftest import (MODIFIED, FakeStore, make_driver,
                                              spec)


def test_stat_maps_the_driver_meta_onto_filestat(accessor):
    store = FakeStore({"a.txt": b"hi"})
    stat = make_stat(make_driver(store))
    st = asyncio.run(stat(accessor, spec("/a.txt")))
    assert st.size == 2
    assert st.modified == MODIFIED
    assert st.fingerprint == "fp-a.txt"
    assert st.revision == "rev-a.txt"
    assert st.extra == {"etag": "fp-a.txt"}


def test_stat_root_is_a_directory_without_connecting(accessor):
    store = FakeStore()
    stat = make_stat(make_driver(store))
    st = asyncio.run(stat(accessor, spec("/")))
    assert st.type == FileType.DIRECTORY
    assert store.connects == 0


def test_stat_prefix_is_a_directory(accessor):
    store = FakeStore({"dir/f.txt": b"x"})
    stat = make_stat(make_driver(store))
    assert asyncio.run(stat(accessor, spec("/dir"))).type == FileType.DIRECTORY


def test_stat_missing_is_enoent(accessor):
    stat = make_stat(make_driver(FakeStore({"a.txt": b"hi"})))
    with pytest.raises(FileNotFoundError):
        asyncio.run(stat(accessor, spec("/never")))


def test_stat_trailing_slash_prefers_the_coexisting_prefix(accessor):
    store = FakeStore({"csv": b"file", "csv/inner.txt": b"x"})
    stat = make_stat(make_driver(store))
    assert asyncio.run(stat(accessor,
                            spec("/csv"))).type != (FileType.DIRECTORY)
    assert asyncio.run(stat(accessor,
                            spec("/csv/"))).type == FileType.DIRECTORY


def test_stat_index_fast_path_skips_the_store(accessor):
    store = FakeStore({"a.txt": b"hi"})
    driver = make_driver(store)
    index = RAMIndexCacheStore()
    asyncio.run(make_readdir(driver)(accessor, spec("/"), index=index))
    connects = store.connects
    st = asyncio.run(make_stat(driver)(accessor, spec("/a.txt"), index=index))
    assert st.size == 2
    assert store.connects == connects


def test_stat_listed_parent_negative_caches_enoent(accessor):
    store = FakeStore({"a.txt": b"hi"})
    driver = make_driver(store)
    index = RAMIndexCacheStore()
    asyncio.run(make_readdir(driver)(accessor, spec("/"), index=index))
    connects = store.connects
    with pytest.raises(FileNotFoundError):
        asyncio.run(make_stat(driver)(accessor, spec("/.git"), index=index))
    assert store.connects == connects


@pytest.mark.asyncio
@pytest.mark.parametrize('warmup', ['find', 'du'])
@pytest.mark.parametrize('expiry', ['expired', 'missing'])
@pytest.mark.parametrize('replacement', ['deleted', 'file', 'directory'])
async def test_recursive_metadata_requires_a_fresh_listing(
        accessor, warmup, expiry, replacement):
    store = FakeStore({'data/old.txt': b'old'})
    driver = make_driver(store)
    index = RAMIndexCacheStore(ttl=60)
    path = spec('/data')
    stat = make_stat(driver)
    find = make_find(driver)
    size = make_du_size(driver)
    with patch('mirage.cache.index.ram.datetime') as clock:
        clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
        if warmup == 'find':
            await find(accessor, path, index=index)
        else:
            await size(accessor, path, index)
        store.connects = 0
        assert (await stat(accessor, path, index)).type == FileType.DIRECTORY
        assert store.connects == 0
        store.objects.clear()
        if replacement == 'file':
            store.objects['data'] = b'new file'
        elif replacement == 'directory':
            store.objects['data/new.txt'] = b'new contents'
        if expiry == 'expired':
            clock.now.return_value += timedelta(seconds=61)
        else:
            await index.invalidate_dir(path.virtual)
        if replacement == 'deleted':
            with pytest.raises(FileNotFoundError):
                await stat(accessor, path, index)
            assert await find(accessor, path, index=index) == []
        else:
            current = await stat(accessor, path, index)
            assert current.type == (FileType.FILE if replacement == 'file' else
                                    FileType.DIRECTORY)
        with pytest.raises(FileNotFoundError):
            await stat(accessor, spec('/data/old.txt'), index)
        assert await size(accessor, path,
                          index) == sum(map(len, store.objects.values()))


@pytest.mark.asyncio
@pytest.mark.parametrize('refresh', ['find', 'readdir'])
async def test_refresh_does_not_revive_an_expired_folder(accessor, refresh):
    store = FakeStore({'data/old.txt': b'old'})
    driver = make_driver(store)
    index = RAMIndexCacheStore(ttl=60)
    path = spec('/data')
    find = make_find(driver)
    with patch('mirage.cache.index.ram.datetime') as clock:
        clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
        await find(accessor, path, index=index)
        store.objects.clear()
        store.objects.update({'data': b'file', 'data/new.txt': b'new'})
        clock.now.return_value += timedelta(seconds=61)
        if refresh == 'find':
            await find(accessor, path, index=index)
        else:
            await make_readdir(driver)(accessor, path, index)
        assert (await make_stat(driver)(accessor, path,
                                        index)).type == FileType.FILE
        assert await make_du_size(driver)(accessor, path, index) == 7
