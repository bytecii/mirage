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

import threading
from collections import Counter, OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from time import monotonic, time

from mirage.cache.index.config import ListResult
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.scope import sole_command_started

_WRITES_BY_PREFIX: Counter[str] = Counter()
_HOLDERS_BY_PREFIX: Counter[str] = Counter()
_PREFIX_LOCK = threading.Lock()


def _copied(listing: ListResult) -> ListResult:
    return listing.model_copy(
        update={
            "entries": None
            if listing.entries is None
            else list(listing.entries),
            "partial_entries": None
            if listing.partial_entries is None
            else list(listing.partial_entries),
        }
    )


@dataclass(frozen=True)
class _Read:
    writes_before: int
    read_at: float
    expires_at: float
    listing: ListResult


class ListingMemo:
    """The listings one store read for the running commands.

    A read is served again only to the command that made it, only while
    no listing write to the key prefix has finished since the read began,
    for under LISTING_TRUST_WINDOW seconds, and never past the listing's
    own expiry. Each fill drops the oldest reads no command can be served
    any more, so a read stays held for about one window. The key
    prefix's write count lives while an open memo holds the prefix.

    Args:
        key_prefix (str): the store's key prefix, whose writes count.
    """

    def __init__(self, key_prefix: str) -> None:
        self._key_prefix = key_prefix
        self._reads: OrderedDict[tuple[int, str], _Read] = OrderedDict()
        self._closed = False
        with _PREFIX_LOCK:
            _HOLDERS_BY_PREFIX[key_prefix] += 1

    def _live(self, kept: _Read) -> bool:
        return (
            kept.writes_before == _WRITES_BY_PREFIX[self._key_prefix]
            and monotonic() - kept.read_at < LISTING_TRUST_WINDOW
            and time() < kept.expires_at
        )

    async def read(
        self,
        folder: str,
        fetch: Callable[[], Awaitable[tuple[ListResult, float | None]]],
    ) -> ListResult:
        """A folder's listing, read from Redis at most once per command.

        Args:
            folder (str): the listed folder's key.
            fetch (Callable[[], Awaitable[tuple[ListResult, float | None]]]):
                reads the listing from Redis and answers it with its
                expiry, or with None when there is no live listing to keep.
        """
        stamp = sole_command_started()
        if stamp is None:
            return (await fetch())[0]
        kept = self._reads.get((stamp, folder))
        if kept is not None and self._live(kept):
            return _copied(kept.listing)
        writes = _WRITES_BY_PREFIX[self._key_prefix]
        read_at = monotonic()
        listing, expires_at = await fetch()
        if expires_at is None or _WRITES_BY_PREFIX[self._key_prefix] != writes:
            return listing
        while self._reads and not self._live(next(iter(self._reads.values()))):
            self._reads.popitem(last=False)
        self._reads.pop((stamp, folder), None)
        self._reads[stamp, folder] = _Read(
            writes, read_at, expires_at, listing
        )
        return _copied(listing)

    def wrote(self) -> None:
        """Count a finished listing write to the key prefix."""
        with _PREFIX_LOCK:
            _WRITES_BY_PREFIX[self._key_prefix] += 1

    def close(self) -> None:
        """Drop the kept listings and release the key prefix.

        The last open memo on a prefix drops its write count, so a host
        that cycles through prefixes keeps none it no longer uses.
        """
        self._reads.clear()
        if self._closed:
            return
        self._closed = True
        with _PREFIX_LOCK:
            _HOLDERS_BY_PREFIX[self._key_prefix] -= 1
            if _HOLDERS_BY_PREFIX[self._key_prefix] <= 0:
                del _HOLDERS_BY_PREFIX[self._key_prefix]
                _WRITES_BY_PREFIX.pop(self._key_prefix, None)
