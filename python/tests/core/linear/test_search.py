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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import unsearched_text
from mirage.core.linear.search import SEARCH_LIMIT, files_containing
from mirage.types import PathSpec

TEAM = {"id": "T1", "key": "ENG", "name": "Engineering"}


def _issue(issue_id: str, title: str, state: str) -> dict:
    return {
        "id": issue_id,
        "identifier": f"ENG-{issue_id[-1]}",
        "title": title,
        "description": "",
        "team": TEAM,
        "state": {"id": "S", "name": state},
    }


ISSUES = [
    _issue("I1", "Fix the login page", "Todo"),
    _issue("I2", "Write release notes", "Blocked"),
]


def _scope(vfs_path: str = "") -> PathSpec:
    virtual = "/linear/" + vfs_path if vfs_path else "/linear"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


async def _ask(
    text: str, named: list[str], under: list[PathSpec] | None = None
):
    accessor = LinearAccessor(LinearConfig(api_key="k", content_search=True))
    found = AsyncMock(return_value=[{"id": i} for i in named])
    with (
        patch(
            "mirage.core.linear.readdir.list_teams",
            AsyncMock(return_value=[TEAM]),
        ),
        patch(
            "mirage.core.linear.readdir.list_team_issues",
            AsyncMock(return_value=ISSUES),
        ),
        patch("mirage.core.linear.search.search_issues", found),
    ):
        out = await files_containing(
            accessor, text, under or [_scope()], RAMIndexCacheStore()
        )
    return out, [call.args[1] for call in found.await_args_list]


def test_unsearched_text_leaves_out_title_and_description():
    kept = unsearched_text(ISSUES[0])
    assert "todo" in kept and "engineering" in kept
    assert "login" not in kept


# Linear names the issue whose title holds the word; the other is named by
# its state, which Linear's search does not read.
@pytest.mark.asyncio
async def test_hits_are_what_linear_names_and_what_the_listing_kept():
    out, asked = await _ask("Blocked", ["I1"])
    assert out is not None
    assert sorted(p.vfs_path.rsplit("/", 2)[-2] for p in out) == [
        "ENG-1__I1",
        "ENG-2__I2",
    ]
    assert all(p.vfs_path.endswith("/issue.json") for p in out)
    assert asked == ["Blocked", "locked"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, named, under",
    [
        ("title", ["I1"], ""),
        ("true", ["I1"], ""),
        ("q4", ["I1"], ""),
        ("login", [], ""),
        ("login", [f"X{i}" for i in range(SEARCH_LIMIT)], ""),
        ("login", ["I1"], "teams/ENG__Engineering__T1/issues/ENG-1__I1"),
    ],
)
async def test_an_unsure_answer_reads_every_file(text, named, under):
    out, _ = await _ask(text, named, [_scope(under)])
    assert out is None
