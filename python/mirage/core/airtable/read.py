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

from mirage.accessor.airtable import AirtableAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.airtable.client import list_bases, list_records, list_tables
from mirage.core.airtable.errors import AirtableAPIError
from mirage.core.airtable.normalize import (normalize_base, normalize_table,
                                            records_jsonl, to_json_bytes)
from mirage.core.airtable.readdir import schema_table
from mirage.core.airtable.scope import detect_scope
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.types import PathSpec
from mirage.utils.errors import efbig, enoent


def ensure_in_scope(accessor: AirtableAccessor, match: ScopeMatch,
                    path: PathSpec) -> None:
    """Refuse a path whose base the mount's ``base_ids`` excludes.

    A reader reaches the API by the id in the path without resolving it
    through the listing, so the scope has to be enforced here too, or a
    typed path would read a base that ``ls`` and ``stat`` call absent.

    Args:
        accessor (AirtableAccessor): the account and its scope.
        match (ScopeMatch): the classified path.
        path (PathSpec): the path, for the error.
    """
    wanted = accessor.config.base_ids
    if wanted is not None and match.slots["base_id"] not in wanted:
        raise enoent(path.virtual)


async def _read_base_json(accessor: AirtableAccessor, match: ScopeMatch,
                          path: PathSpec, index: IndexCacheStore) -> bytes:
    ensure_in_scope(accessor, match, path)
    base_id = match.slots["base_id"]
    for base in await list_bases(accessor):
        if base.get("id") == base_id:
            tables = await list_tables(accessor, base_id)
            return to_json_bytes(normalize_base(base, tables))
    raise enoent(path.virtual)


async def _read_table_json(accessor: AirtableAccessor, match: ScopeMatch,
                           path: PathSpec, index: IndexCacheStore) -> bytes:
    ensure_in_scope(accessor, match, path)
    try:
        table = await schema_table(accessor, match)
    except FileNotFoundError:
        raise enoent(path.virtual) from None
    return to_json_bytes(normalize_table(table, match.slots["base_id"]))


async def _render_records(accessor: AirtableAccessor, match: ScopeMatch,
                          path: PathSpec, view: str | None, limit: int | None,
                          offset: int | None) -> bytes:
    ensure_in_scope(accessor, match, path)
    cap = accessor.config.max_read_records
    skip = offset or 0
    # A window is a record count pushed into maxRecords. One record past
    # the cap proves the full answer would exceed it, without paging
    # through the rest of a large table first.
    wanted = cap + 1 if limit is None else min(skip + limit, cap + 1)
    try:
        records = await list_records(accessor,
                                     match.slots["base_id"],
                                     match.slots["table_id"],
                                     view=view,
                                     max_records=wanted)
    except AirtableAPIError as exc:
        if exc.not_found:
            raise enoent(path.virtual) from None
        raise
    if len(records) > cap:
        # EFBIG, reported per operand as `<cmd>: <path>: File too large`:
        # the whole file would render more than this mount allows.
        raise efbig(path)
    return records_jsonl(records[skip:])


async def _read_records(accessor: AirtableAccessor, match: ScopeMatch,
                        path: PathSpec, index: IndexCacheStore,
                        limit: int | None, offset: int | None) -> bytes:
    return await _render_records(accessor, match, path, None, limit, offset)


async def _read_view(accessor: AirtableAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore, limit: int | None,
                     offset: int | None) -> bytes:
    return await _render_records(accessor, match, path, match.slots["view_id"],
                                 limit, offset)


read = make_read(
    detect_scope,
    readers={
        "base_json": _read_base_json,
        "table_json": _read_table_json,
    },
    windowed={
        "records": _read_records,
        "view": _read_view,
    },
)
