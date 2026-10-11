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

import aiohttp
import pytest

import mirage.core.gdrive.search as search_mod
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.gdrive.search import PARENTS_PER_QUERY, files_containing
from mirage.types import PathSpec


def scope(vfs_path: str = "") -> PathSpec:
    virtual = "/gd/" + vfs_path if vfs_path else "/gd"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


@pytest.mark.asyncio
async def test_hits_are_the_walked_files_drive_names(
    fake_drive, gdrive_accessor
):
    sub = fake_drive.folder("sub")
    fake_drive.add("a.txt", content=b"the wombat")
    fake_drive.add("b.txt", parent=sub, content=b"wombat here")
    fake_drive.add("c.txt", content=b"nothing")
    out = await files_containing(
        gdrive_accessor, "wombat", [scope()], RAMIndexCacheStore()
    )
    assert out is not None
    assert sorted(p.virtual for p in out) == ["/gd/a.txt", "/gd/sub/b.txt"]
    assert fake_drive.searches == [["root", sub]]


@pytest.mark.asyncio
async def test_a_subfolder_scope_searches_from_its_folder(
    fake_drive, gdrive_accessor
):
    sub = fake_drive.folder("sub")
    fake_drive.add("a.txt", content=b"wombat")
    fake_drive.add("b.txt", parent=sub, content=b"wombat")
    out = await files_containing(
        gdrive_accessor, "wombat", [scope("sub")], RAMIndexCacheStore()
    )
    assert out is not None
    assert [(p.virtual, p.vfs_path) for p in out] == [
        ("/gd/sub/b.txt", "sub/b.txt")
    ]
    assert fake_drive.searches == [[sub]]


@pytest.mark.asyncio
async def test_many_folders_are_searched_in_batches(
    fake_drive, gdrive_accessor
):
    for i in range(PARENTS_PER_QUERY + 5):
        fake_drive.folder(f"d{i:02d}")
    fake_drive.add("a.txt", content=b"wombat")
    out = await files_containing(
        gdrive_accessor, "wombat", [scope()], RAMIndexCacheStore()
    )
    assert out is not None
    assert [len(s) for s in fake_drive.searches] == [PARENTS_PER_QUERY, 6]


@pytest.mark.asyncio
async def test_a_file_drive_has_not_indexed_is_left_out(
    fake_drive, gdrive_accessor
):
    fake_drive.add("a.txt", content=b"wombat")
    late = fake_drive.add("b.txt", content=b"wombat")
    fake_drive.unindexed.add(late)
    out = await files_containing(
        gdrive_accessor, "wombat", [scope()], RAMIndexCacheStore()
    )
    assert out is not None
    assert [p.virtual for p in out] == ["/gd/a.txt"]


@pytest.mark.asyncio
async def test_no_hit_answers_none(fake_drive, gdrive_accessor):
    fake_drive.add("a.txt", content=b"nothing")
    out = await files_containing(
        gdrive_accessor, "wombat", [scope()], RAMIndexCacheStore()
    )
    assert out is None


@pytest.mark.asyncio
async def test_an_incomplete_search_answers_none(fake_drive, gdrive_accessor):
    fake_drive.add("a.txt", content=b"wombat")
    fake_drive.incomplete = True
    out = await files_containing(
        gdrive_accessor, "wombat", [scope()], RAMIndexCacheStore()
    )
    assert out is None


@pytest.mark.asyncio
async def test_a_failed_search_answers_none(
    fake_drive, gdrive_accessor, monkeypatch
):
    fake_drive.add("a.txt", content=b"wombat")

    async def refuse(*args, **kwargs):
        raise aiohttp.ClientConnectionError("down")

    monkeypatch.setattr(search_mod, "search_files", refuse)
    out = await files_containing(
        gdrive_accessor, "wombat", [scope()], RAMIndexCacheStore()
    )
    assert out is None
