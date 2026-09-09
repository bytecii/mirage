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

import json
import math
from collections.abc import Awaitable
from datetime import datetime, timezone
from typing import Any, cast

try:
    from redis.asyncio import Redis
except ImportError as _err:
    raise ImportError("RedisIndexCacheStore requires the 'redis' extra. "
                      "Install with: pip install mirage-ai[redis]") from _err

from mirage.cache.index.config import (IndexEntry, ListResult, LookupResult,
                                       LookupStatus)
from mirage.cache.index.store import IndexCacheStore
from mirage.core.timeutil import to_iso_z
from mirage.utils.key_prefix import under_path

ENTRY_PREFIX = "mirage:idx:entry:"
CHILDREN_PREFIX = "mirage:idx:children:"
INVALIDATED_KEY = "mirage:idx:invalidated_at"
LISTING_CHILDREN = "children"
LISTING_WRITTEN_AT = "written_at"
LISTING_EXPIRES_AT = "expires_at"
# The least time a listing outlives its own expiry in Redis, in seconds.
MIN_EXPIRED_RETENTION = 60.0


def _text(value: str | bytes) -> str:
    return value.decode() if isinstance(value, bytes) else value


def _glob_escape(value: str) -> str:
    """Escape redis MATCH metacharacters in a literal path.

    A path may legally contain ``*?[]``, and SCAN's pattern is a glob, so
    an unescaped path would match keys it does not name. The escaping is
    a narrowing optimization only; the caller still filters the results
    at a path boundary.

    Args:
        value (str): A literal path to embed in a MATCH pattern.
    """
    out: list[str] = []
    for char in value:
        if char in "*?[]\\":
            out.append("\\")
        out.append(char)
    return "".join(out)


def listing_document(children: list[str], written_at: float,
                     expires_at: float) -> str:
    """The JSON a directory listing is stored as.

    A JSON document rather than a Redis list, because Redis has no empty
    list: ``RPUSH`` with no values creates no key, so a directory with no
    children could never be recorded as listed, every ``ls`` of it was a
    cold backend call, and no negative lookup under it was ever absorbed.
    The two stamps are epoch seconds rather than ISO strings so both
    languages compare them as numbers; the TypeScript store writes the
    same three keys (``listingDocument`` in ``cache/index/redis.ts``).

    Args:
        children (list[str]): the mount-absolute child keys, in readdir
            order.
        written_at (float): when the listing was written, epoch seconds.
        expires_at (float): when it stops being fresh, epoch seconds.
    """
    return json.dumps(
        {
            LISTING_CHILDREN: children,
            LISTING_WRITTEN_AT: written_at,
            LISTING_EXPIRES_AT: expires_at,
        },
        separators=(",", ":"))


def physical_ttl_seconds(written_at: float, expires_at: float) -> int:
    """How long Redis keeps a listing: its freshness plus a retention.

    Freshness is decided by the caller from the document's own stamps,
    never by Redis dropping the key, so the key has to outlive its
    expiry: while it does, a lookup answers EXPIRED exactly as the RAM
    store does for a stale row it still holds, and only once Redis has
    forgotten it does the answer become NOT_FOUND. The retention is one
    more TTL and at least a minute. RAM keeps a stale row until something
    drops it, but Redis is a shared server and its keyspace needs a bound.

    Args:
        written_at (float): when the listing was written, epoch seconds.
        expires_at (float): when it stops being fresh, epoch seconds.
    """
    fresh_for = max(0.0, expires_at - written_at)
    return math.ceil(fresh_for + max(fresh_for, MIN_EXPIRED_RETENTION))


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RedisIndexCacheStore(IndexCacheStore):
    """Redis-backed index cache for remote resource metadata.

    Entries are the JSON pydantic writes for ``IndexEntry`` (snake_case,
    every field), and that is the wire format the TypeScript store reads
    and writes too, so one Redis can serve both. A directory listing is
    one JSON document (``listing_document``) carrying the child keys and
    two epoch-second stamps, ``written_at`` and ``expires_at``.

    Freshness is decided here, from those stamps, not by Redis dropping
    the key: the key outlives its expiry (``physical_ttl_seconds``), so
    a lookup in that window answers EXPIRED as the RAM store does, and
    ``invalidate`` writes one ``invalidated_at`` marker that every
    listing written before it compares stale against, entries kept.
    ``list_dir`` is therefore one ``MGET`` of the listing and the marker.

    The key layout is::

        {key_prefix}mirage:idx:entry:{resource_path}     -> IndexEntry JSON
        {key_prefix}mirage:idx:children:{resource_path}  -> listing JSON
        {key_prefix}mirage:idx:invalidated_at            -> epoch seconds

    Multiple stores can share one Redis server by using distinct
    ``key_prefix`` values (e.g. ``"gdrive:"``, ``"s3:"``).

    Args:
        ttl (float): Default time-to-live in seconds for directory listings.
        url (str): Redis connection URL, used when *client* is not provided.
        client (Redis | None): Pre-existing async Redis client. When given,
            the store will not close it on ``close()``.
        key_prefix (str): Namespace prefix prepended to every Redis key,
            allowing multiple stores to coexist on the same server.
    """

    def __init__(
        self,
        ttl: float = 600,
        url: str = "redis://localhost:6379/0",
        client: Redis | None = None,
        key_prefix: str = "",
    ) -> None:
        super().__init__()
        self._ttl = ttl
        self._client = (client if client is not None else Redis.from_url(
            url, decode_responses=True))
        self._owns_client = client is None
        self._pending_seed: tuple[dict[str, IndexEntry], dict[str, list[str]],
                                  datetime] | None = None
        p = key_prefix or ""
        self._entry_prefix = f"{p}{ENTRY_PREFIX}"
        self._children_prefix = f"{p}{CHILDREN_PREFIX}"
        self._invalidated_key = f"{p}{INVALIDATED_KEY}"

    def _entry_key(self, resource_path: str) -> str:
        return f"{self._entry_prefix}{resource_path}"

    def _children_key(self, resource_path: str) -> str:
        return f"{self._children_prefix}{resource_path}"

    def seed(self, entries: dict[str, IndexEntry],
             children: dict[str, list[str]], expires_at: datetime) -> None:
        self._pending_seed = (dict(entries), {
            path: list(keys)
            for path, keys in children.items()
        }, expires_at)

    async def _flush_seed(self) -> None:
        pending = self._pending_seed
        if pending is None:
            return
        entries, children, expires_at = pending
        now = _now()
        now_iso = to_iso_z(now)
        pipe = self._client.pipeline()
        for resource_path, entry in entries.items():
            if not entry.index_time:
                entry = entry.model_copy(update={"index_time": now_iso})
            pipe.set(self._entry_key(resource_path), entry.model_dump_json())
        for resource_path, child_keys in children.items():
            self._write_listing(pipe, resource_path, child_keys,
                                now.timestamp(), expires_at.timestamp())
        await pipe.execute()
        if self._pending_seed is pending:
            self._pending_seed = None

    def _write_listing(self, pipe: Any, resource_path: str,
                       child_keys: list[str], written_at: float,
                       expires_at: float) -> None:
        """Queue one listing document on a pipeline.

        Args:
            pipe (Any): the redis pipeline the write rides on.
            resource_path (str): the directory being listed.
            child_keys (list[str]): its children, mount-absolute.
            written_at (float): now, epoch seconds.
            expires_at (float): when the listing stops being fresh.
        """
        pipe.set(self._children_key(resource_path),
                 listing_document(list(child_keys), written_at, expires_at),
                 ex=physical_ttl_seconds(written_at, expires_at))

    async def get(self, resource_path: str) -> LookupResult:
        await self._flush_seed()
        raw = await self._client.get(self._entry_key(resource_path))
        if raw is None:
            return LookupResult(status=LookupStatus.NOT_FOUND)
        entry = IndexEntry.model_validate_json(raw)
        return LookupResult(entry=entry)

    async def put(self, resource_path: str, entry: IndexEntry) -> None:
        await self._flush_seed()
        if not entry.index_time:
            entry = entry.model_copy(update={"index_time": to_iso_z(_now())})
        await self._client.set(self._entry_key(resource_path),
                               entry.model_dump_json())

    async def list_dir(self, resource_path: str) -> ListResult:
        await self._flush_seed()
        raw_listing, raw_marker = await cast(
            "Awaitable[list[str | bytes | None]]",
            self._client.mget(
                [self._children_key(resource_path), self._invalidated_key]))
        if raw_listing is None:
            return ListResult(status=LookupStatus.NOT_FOUND)
        listing: dict[str, Any] = json.loads(_text(raw_listing))
        # Stale when its own expiry has passed, or when `invalidate` ran
        # after it was written; both mirror the RAM store's expiry map.
        if _now().timestamp() > listing[LISTING_EXPIRES_AT]:
            return ListResult(status=LookupStatus.EXPIRED)
        if raw_marker is not None and float(
                _text(raw_marker)) >= listing[LISTING_WRITTEN_AT]:
            return ListResult(status=LookupStatus.EXPIRED)
        return ListResult(
            entries=[str(child) for child in listing[LISTING_CHILDREN]])

    async def set_dir(
        self,
        resource_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        await self._flush_seed()
        now = _now()
        now_iso = to_iso_z(now)
        prefix = "/" if resource_path == "/" else resource_path + "/"

        pipe = self._client.pipeline()
        child_keys: list[str] = []
        for name, entry in entries:
            full_path = prefix + name
            if not entry.index_time:
                entry = entry.model_copy(update={"index_time": now_iso})
            pipe.set(self._entry_key(full_path), entry.model_dump_json())
            child_keys.append(full_path)

        expires_at = (expired_at.timestamp()
                      if expired_at else now.timestamp() + self._ttl)
        self._write_listing(pipe, resource_path, child_keys, now.timestamp(),
                            expires_at)
        await pipe.execute()

    async def entries(self) -> dict[str, IndexEntry]:
        await self._flush_seed()
        entries: dict[str, IndexEntry] = {}
        cursor = 0
        while True:
            cursor, keys = await self._client.scan(
                cursor, match=f"{self._entry_prefix}*", count=500)
            for key in keys:
                key_text = _text(key)
                raw = await self._client.get(key)
                if raw is not None:
                    resource_path = key_text.removeprefix(self._entry_prefix)
                    entries[resource_path] = IndexEntry.model_validate_json(
                        raw)
            if cursor == 0:
                return entries

    async def invalidate_dir(self, resource_path: str) -> None:
        await self._flush_seed()
        children_key = self._children_key(resource_path)
        raw = await self._client.get(children_key)
        pipe = self._client.pipeline()
        if raw is not None:
            for child in json.loads(_text(raw))[LISTING_CHILDREN]:
                pipe.delete(self._entry_key(str(child)))
        pipe.delete(children_key)
        await pipe.execute()

    async def _scan_delete(self, prefix: str, resource_path: str) -> None:
        """Delete every key under ``prefix`` naming a path in the subtree.

        Args:
            prefix (str): Key namespace to scan (entries or children).
            resource_path (str): Mount-absolute root of the subtree.
        """
        pattern = f"{prefix}{_glob_escape(resource_path.rstrip('/'))}*"
        cursor = 0
        while True:
            cursor, keys = await self._client.scan(cursor,
                                                   match=pattern,
                                                   count=500)
            doomed = [
                key for key in keys
                if under_path(_text(key).removeprefix(prefix), resource_path)
            ]
            if doomed:
                await self._client.delete(*doomed)
            if cursor == 0:
                return

    async def invalidate_prefix(self, resource_path: str) -> None:
        await self._flush_seed()
        await self._scan_delete(self._entry_prefix, resource_path)
        await self._scan_delete(self._children_prefix, resource_path)

    async def invalidate(self) -> None:
        """Mark every listing stale without discarding it.

        One marker key, ``invalidated_at``, rather than a rewrite of every
        listing: ``list_dir`` reads it beside the listing in the same
        ``MGET`` and calls a listing written at or before it EXPIRED. A
        listing written afterwards is fresh again, and entries are left
        alone, so ``get`` keeps answering, which is what the RAM store's
        in-place expiry gives a backend whose index *is* its listing
        (github, hf_hub): a refetch instead of an ENOENT.
        """
        await self._flush_seed()
        await self._client.set(self._invalidated_key, str(_now().timestamp()))

    async def clear(self) -> None:
        self._pending_seed = None
        for prefix in (self._entry_prefix, self._children_prefix):
            cursor = 0
            while True:
                cursor, keys = await self._client.scan(cursor,
                                                       match=f"{prefix}*",
                                                       count=500)
                if keys:
                    await self._client.delete(*keys)
                if cursor == 0:
                    break
        await self._client.delete(self._invalidated_key)

    async def close(self) -> None:
        if self._closed:
            return
        # A seed the caller queued is a write it asked for: the RAM store
        # lands it synchronously, so a store closed before its first
        # lookup must not lose it.
        await self._flush_seed()
        if self._owns_client:
            await self._client.aclose()
        await super().close()
