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
from uuid import uuid4

import pytest

from mirage.cache.index import LookupStatus, listing_memo
from mirage.cache.index.config import ListResult
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.listing_memo import ListingMemo
from mirage.cache.index.scope import command_scope

WALL = 2_000_000_000.0


class Clock:
    def __init__(self) -> None:
        self.elapsed = 0.0

    def monotonic(self) -> float:
        return 1_000.0 + self.elapsed

    def time(self) -> float:
        return WALL + self.elapsed


class Folder:
    def __init__(
        self,
        entries: list[str] | None = None,
        partial: bool = False,
        expires_at: float | None = WALL + 60,
    ) -> None:
        self.entries = ["/d/a", "/d/b"] if entries is None else entries
        self.partial = partial
        self.expires_at = expires_at
        self.reads = 0
        self.gate: asyncio.Event | None = None
        self.entered = asyncio.Event()

    async def __call__(self) -> tuple[ListResult, float | None]:
        self.reads += 1
        self.entered.set()
        if self.gate is not None:
            await self.gate.wait()
        if self.expires_at is None:
            return ListResult(status=LookupStatus.NOT_FOUND), None
        if self.partial:
            return ListResult(partial_entries=list(self.entries)), (
                self.expires_at
            )
        return ListResult(entries=list(self.entries)), self.expires_at


@pytest.fixture
def clock(monkeypatch):
    fake = Clock()
    monkeypatch.setattr(listing_memo, "monotonic", fake.monotonic)
    monkeypatch.setattr(listing_memo, "time", fake.time)
    return fake


@pytest.fixture
def memo(clock):
    return ListingMemo(f"test:{uuid4()}:")


def held(memo: ListingMemo) -> set[str]:
    return {folder for _, folder in memo._reads}


@pytest.mark.asyncio
async def test_one_command_reads_a_listing_once(memo):
    folder = Folder()
    async with command_scope():
        within = [await memo.read("/d", folder) for _ in range(10)]
    assert folder.reads == 1
    outside = [await memo.read("/d", folder) for _ in range(10)]
    assert folder.reads == 11
    assert within == outside
    assert within[0].entries == ["/d/a", "/d/b"]


@pytest.mark.asyncio
async def test_each_command_reads_its_own_listing(memo):
    folder = Folder()
    for _ in range(2):
        async with command_scope():
            await memo.read("/d", folder)
            await memo.read("/d", folder)
    assert folder.reads == 2
    async with command_scope():
        await memo.read("/d", folder)
        async with command_scope():
            await memo.read("/d", folder)
        await memo.read("/d", folder)
    assert folder.reads == 4


@pytest.mark.asyncio
async def test_a_listing_without_an_expiry_is_read_each_time(memo):
    folder = Folder(expires_at=None)
    async with command_scope():
        for _ in range(2):
            assert (
                await memo.read("/d", folder)
            ).status is LookupStatus.NOT_FOUND
    assert folder.reads == 2


@pytest.mark.asyncio
async def test_a_finished_write_on_the_prefix_drops_the_listing_read(memo):
    folder = Folder()
    other = ListingMemo(f"test:{uuid4()}:")
    async with command_scope():
        await memo.read("/d", folder)
        other.wrote()
        await memo.read("/d", folder)
        assert folder.reads == 1
        ListingMemo(memo._key_prefix).wrote()
        await memo.read("/d", folder)
    assert folder.reads == 2


def test_the_last_close_on_a_prefix_releases_its_count(memo):
    prefix = memo._key_prefix
    peer = ListingMemo(prefix)
    peer.wrote()
    memo.close()
    assert listing_memo._WRITES_BY_PREFIX[prefix] == 1
    peer.close()
    assert prefix not in listing_memo._WRITES_BY_PREFIX
    assert prefix not in listing_memo._HOLDERS_BY_PREFIX


@pytest.mark.asyncio
async def test_a_closed_peer_leaves_a_live_memo_its_count(memo):
    folder = Folder()
    peer = ListingMemo(memo._key_prefix)
    peer.wrote()
    async with command_scope():
        await memo.read("/d", folder)
        peer.close()
        peer.close()
        await memo.read("/d", folder)
        assert folder.reads == 1
        ListingMemo(memo._key_prefix).wrote()
        await memo.read("/d", folder)
    assert folder.reads == 2


@pytest.mark.asyncio
async def test_a_write_that_finishes_after_close_still_counts(clock):
    prefix = f"test:{uuid4()}:"
    closed = ListingMemo(prefix)
    closed.close()
    memo = ListingMemo(prefix)
    folder = Folder()
    async with command_scope():
        await memo.read("/d", folder)
        closed.wrote()
        await memo.read("/d", folder)
    assert folder.reads == 2


@pytest.mark.asyncio
async def test_a_read_that_overlaps_a_finished_write_is_not_kept(memo):
    folder = Folder()
    folder.gate = asyncio.Event()
    async with command_scope():
        reading = asyncio.create_task(memo.read("/d", folder))
        await folder.entered.wait()
        memo.wrote()
        folder.gate.set()
        await reading
        await memo.read("/d", folder)
    assert folder.reads == 2


@pytest.mark.asyncio
async def test_a_listing_is_trusted_for_under_the_window(memo, clock):
    folder = Folder()
    async with command_scope():
        await memo.read("/d", folder)
        clock.elapsed = LISTING_TRUST_WINDOW * 0.9
        await memo.read("/d", folder)
        assert folder.reads == 1
        clock.elapsed = LISTING_TRUST_WINDOW
        await memo.read("/d", folder)
    assert folder.reads == 2


@pytest.mark.asyncio
async def test_a_listing_is_never_served_past_its_expiry(memo, clock):
    folder = Folder(expires_at=WALL + LISTING_TRUST_WINDOW / 4)
    async with command_scope():
        await memo.read("/d", folder)
        clock.elapsed = LISTING_TRUST_WINDOW / 4
        await memo.read("/d", folder)
    assert folder.reads == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("partial", [False, True])
async def test_a_caller_cannot_change_a_later_answer(memo, partial):
    folder = Folder(partial=partial)
    field = "partial_entries" if partial else "entries"
    async with command_scope():
        getattr(await memo.read("/d", folder), field).append("/d/x")
        getattr(await memo.read("/d", folder), field).clear()
        after = await memo.read("/d", folder)
    assert folder.reads == 1
    assert getattr(after, field) == ["/d/a", "/d/b"]


@pytest.mark.asyncio
async def test_a_fill_drops_the_listings_no_command_can_be_served(memo, clock):
    async with command_scope():
        async with command_scope():
            await memo.read("/aged", Folder())
        clock.elapsed = LISTING_TRUST_WINDOW * 0.6
        live = Folder()
        await memo.read("/live", live)
        clock.elapsed = LISTING_TRUST_WINDOW * 1.2
        async with command_scope():
            await memo.read("/next", Folder())
        assert held(memo) == {"/live", "/next"}
        await memo.read("/live", live)
        assert live.reads == 1


@pytest.mark.asyncio
async def test_a_fill_drops_the_listings_a_write_or_expiry_ended(memo, clock):
    async with command_scope():
        await memo.read("/written", Folder())
        memo.wrote()
        await memo.read("/expiring", Folder(expires_at=WALL + 0.1))
        clock.elapsed = 0.1
        await memo.read("/next", Folder())
    assert held(memo) == {"/next"}
