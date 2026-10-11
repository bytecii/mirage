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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.trello.normalize import unsearched_text
from mirage.core.trello.search import SEARCH_LIMIT, files_containing
from mirage.types import PathSpec
from mirage.vfs.trello.config import TrelloConfig

CARDS = [
    {
        "id": "c1",
        "name": "Fix login",
        "desc": "broken",
        "idBoard": "b1",
        "idList": "l1",
        "shortUrl": "https://trello.test/c1",
    },
    {
        "id": "c2",
        "name": "Write notes",
        "desc": "",
        "idBoard": "b1",
        "idList": "l1",
        "url": "https://trello.test/c/c2/2-ship-it",
    },
]

LIST = "workspaces/Engineering__ws1/boards/Roadmap__b1/lists/Doing__l1"


def _scope(vfs_path: str = "") -> PathSpec:
    virtual = "/trello/" + vfs_path if vfs_path else "/trello"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


async def _ask(
    text: str, named: list[str], under: list[PathSpec] | None = None
):
    accessor = TrelloAccessor(
        TrelloConfig(api_key="k", api_token="t", content_search=True)
    )
    found = AsyncMock(return_value=[{"id": i} for i in named])
    readdir = "mirage.core.trello.readdir"
    with (
        patch(
            f"{readdir}.list_workspaces",
            AsyncMock(
                return_value=[{"id": "ws1", "displayName": "Engineering"}]
            ),
        ),
        patch(
            f"{readdir}.list_workspace_boards",
            AsyncMock(return_value=[{"id": "b1", "name": "Roadmap"}]),
        ),
        patch(
            f"{readdir}.get_board",
            AsyncMock(return_value={"id": "b1", "name": "Roadmap"}),
        ),
        patch(
            f"{readdir}.list_board_lists",
            AsyncMock(return_value=[{"id": "l1", "name": "Doing"}]),
        ),
        patch(f"{readdir}.list_list_cards", AsyncMock(return_value=CARDS)),
        patch("mirage.core.trello.search.search_cards", found),
    ):
        out = await files_containing(
            accessor, text, under or [_scope()], RAMIndexCacheStore()
        )
    return out, [call.args[1] for call in found.await_args_list]


def test_unsearched_text_leaves_out_name_and_description():
    kept = unsearched_text(CARDS[1])
    assert "ship" in kept and "c2" in kept
    assert "notes" not in kept and "write" not in kept


# Trello names the card whose name holds the word; the other is named by
# its link, which Trello's search does not read.
@pytest.mark.asyncio
async def test_hits_are_what_trello_names_and_what_the_listing_kept():
    out, asked = await _ask("ship", ["c1"])
    assert out is not None
    assert [p.vfs_path for p in out] == [
        f"{LIST}/cards/Fix_login__c1/card.json",
        f"{LIST}/cards/Write_notes__c2/card.json",
    ]
    assert asked == ["ship"]


@pytest.mark.asyncio
async def test_a_card_scope_names_its_own_card_json():
    out, _ = await _ask(
        "login", ["c1"], [_scope(f"{LIST}/cards/Fix_login__c1")]
    )
    assert out is not None
    assert [p.vfs_path for p in out] == [
        f"{LIST}/cards/Fix_login__c1/card.json"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, named",
    [
        ("desc", ["c1"]),
        ("true", ["c1"]),
        ("q4", ["c1"]),
        ("login", []),
        ("login", [f"x{i}" for i in range(SEARCH_LIMIT)]),
    ],
)
async def test_an_unsure_answer_reads_every_file(text, named):
    out, _ = await _ask(text, named)
    assert out is None
