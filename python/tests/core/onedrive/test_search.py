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

import re

import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.onedrive.readdir import readdir
from mirage.core.onedrive.search import files_containing
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0/me/drive"

ROOT = {
    "value": [
        {"id": "1", "name": "a.txt", "size": 7, "file": {}},
        {"id": "2", "name": "c.txt", "size": 7, "file": {}},
        {"id": "9", "name": "Docs", "folder": {"childCount": 1}},
    ]
}
DOCS = {"value": [{"id": "3", "name": "b.txt", "size": 7, "file": {}}]}


def _accessor() -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok"))


def scope(vfs_path: str = "") -> PathSpec:
    virtual = "/od/" + vfs_path if vfs_path else "/od"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


@pytest.mark.asyncio
async def test_hits_are_the_walked_files_graph_names():
    with aioresponses() as m:
        m.get(_BASE + "/root/children", payload=ROOT)
        m.get(_BASE + "/root:/Docs:/children", payload=DOCS)
        m.get(
            re.compile(re.escape(_BASE + "/root/search(q='wombat')") + ".*"),
            payload={"value": [{"id": "3"}, {"id": "1"}, {"id": "9"}]},
        )
        out = await files_containing(
            _accessor(), "wombat", [scope()], RAMIndexCacheStore()
        )
    assert out is not None
    assert sorted(p.virtual for p in out) == ["/od/Docs/b.txt", "/od/a.txt"]


@pytest.mark.asyncio
async def test_a_subfolder_scope_searches_from_its_folder():
    with aioresponses() as m:
        m.get(_BASE + "/root:/Docs:/children", payload=DOCS)
        m.get(
            re.compile(
                re.escape(_BASE + "/root:/Docs:/search(q='wombat')") + ".*"
            ),
            payload={"value": [{"id": "3"}]},
        )
        out = await files_containing(
            _accessor(), "wombat", [scope("Docs")], RAMIndexCacheStore()
        )
    assert out is not None
    assert [(p.virtual, p.vfs_path) for p in out] == [
        ("/od/Docs/b.txt", "Docs/b.txt")
    ]


@pytest.mark.asyncio
async def test_a_file_listed_without_an_id_answers_none():
    index = RAMIndexCacheStore()
    two = {"value": DOCS["value"] + [{"id": "4", "name": "d.txt", "file": {}}]}
    with aioresponses() as m:
        m.get(_BASE + "/root:/Docs:/children", payload=two)
        await readdir(_accessor(), scope("Docs"), index)
    entry = (await index.get("/od/Docs/d.txt")).entry
    assert entry is not None
    entry.extra.pop("id")
    await index.put("/od/Docs/d.txt", entry)
    with aioresponses() as m:
        m.get(
            re.compile(re.escape(_BASE + "/root:/Docs:/search(") + ".*"),
            payload={"value": [{"id": "3"}]},
        )
        out = await files_containing(
            _accessor(), "wombat", [scope("Docs")], index
        )
    assert out is None


@pytest.mark.asyncio
async def test_no_hit_or_a_failed_search_answers_none():
    for reply in ({"payload": {"value": []}}, {"status": 400}):
        with aioresponses() as m:
            m.get(_BASE + "/root:/Docs:/children", payload=DOCS)
            m.get(
                re.compile(re.escape(_BASE + "/root:/Docs:/search(") + ".*"),
                repeat=True,
                **reply,
            )
            out = await files_containing(
                _accessor(), "wombat", [scope("Docs")], RAMIndexCacheStore()
            )
        assert out is None
