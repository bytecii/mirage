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

import pytest

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hierarchy.probe import (
    assert_listed,
    entries_under,
    listed_size,
    resolve_entry,
)
from mirage.core.hierarchy.readdir import make_readdir
from mirage.types import PathSpec
from tests.core.hierarchy.conftest import (
    FakeAccessor,
    detect_scope,
    list_notes,
    list_rooms,
    spec,
)

READDIR = make_readdir(
    detect_scope,
    listers={
        "rooms": list_rooms,
        "room": list_notes,
    },
    static_root=("rooms",),
)


def test_assert_listed_accepts_a_listed_child(accessor):
    index = RAMIndexCacheStore()
    asyncio.run(
        assert_listed(READDIR, accessor, spec("/rooms/red/a.json"), index)
    )


def test_assert_listed_refuses_an_absent_child(accessor):
    index = RAMIndexCacheStore()
    with pytest.raises(FileNotFoundError):
        asyncio.run(
            assert_listed(
                READDIR, accessor, spec("/rooms/red/nope.json"), index
            )
        )


def test_listed_size_reads_what_the_listing_recorded(accessor):
    index = RAMIndexCacheStore()
    path = spec("/rooms/red/a.json")
    asyncio.run(assert_listed(READDIR, accessor, path, index))
    assert asyncio.run(listed_size(index, path)) == 7
    assert asyncio.run(listed_size(index, spec("/rooms/red/ghost.json"))) is (
        None
    )


def test_resolve_entry_warms_the_parent_once(accessor):
    index = RAMIndexCacheStore()
    entry = asyncio.run(
        resolve_entry(READDIR, accessor, spec("/rooms/red/a.json"), index)
    )
    assert entry is not None
    assert entry.id == "a.json"
    assert accessor.calls == ["notes:red"]
    # A warm cache answers from the index without another listing.
    again = asyncio.run(
        resolve_entry(READDIR, accessor, spec("/rooms/red/b.json"), index)
    )
    assert again is not None
    assert accessor.calls == ["notes:red"]


def test_resolve_entry_answers_none_for_an_absent_child(accessor):
    index = RAMIndexCacheStore()
    entry = asyncio.run(
        resolve_entry(READDIR, accessor, spec("/rooms/red/nope.json"), index)
    )
    assert entry is None


def test_entries_under_walks_every_level_through_the_index(accessor):
    index = RAMIndexCacheStore()
    walked = asyncio.run(
        entries_under(
            READDIR,
            accessor,
            spec("/rooms"),
            index,
            lambda entry: entry.resource_type == "fake/room",
        )
    )
    assert walked is not None
    assert sorted((p.virtual, e.id) for p, e in walked) == [
        ("/h/rooms/blue", "blue"),
        ("/h/rooms/red", "red"),
        ("/h/rooms/red/a.json", "a.json"),
        ("/h/rooms/red/b.json", "b.json"),
    ]
    assert sorted(accessor.calls) == ["notes:blue", "notes:red", "rooms"]


async def _unfiled(
    accessor: FakeAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    return [path_spec.virtual.rstrip("/") + "/ghost"]


def test_entries_under_answers_none_for_a_name_with_no_entry(accessor):
    walked = asyncio.run(
        entries_under(
            _unfiled,
            accessor,
            spec("/rooms"),
            RAMIndexCacheStore(),
            lambda entry: False,
        )
    )
    assert walked is None
