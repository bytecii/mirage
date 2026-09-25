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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.notion.client import NotionAPIError
from mirage.core.notion.pages import get_page
from mirage.core.notion.pathing import page_dirname
from mirage.core.notion.readdir import readdir
from mirage.core.notion.scope import detect_scope
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.errors import enoent


def _page_stat(match: ScopeMatch, path: PathSpec,
               entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        modified=entry.remote_time or None,
        extra={"page_id": entry.id},
    )


async def _row_stat(accessor: NotionAccessor, match: ScopeMatch,
                    path: PathSpec, index: IndexCacheStore) -> FileStat:
    # No listing names a row, so the row answers for itself: it exists
    # when the page does, sits in this data source, is not in the trash,
    # and the path spells it as rows.jsonl does.
    name = path.vfs_path.strip("/").split("/")[-1]
    try:
        page = await get_page(accessor.config,
                              match.slots["page_id"],
                              session=accessor.pool)
    except NotionAPIError as exc:
        if exc.status == 404 or exc.code == "validation_error":
            raise enoent(path.virtual)
        raise
    parent = page.get("parent", {})
    if (parent.get("data_source_id") != match.slots["data_source_id"]
            or page.get("in_trash") or page.get("archived")
            or page_dirname(page) != name):
        raise enoent(path.virtual)
    return FileStat(
        name=name,
        type=FileType.DIRECTORY,
        modified=page.get("last_edited_time") or None,
        extra={"page_id": page.get("id", "")},
    )


def _page_json_stat(match: ScopeMatch, path: PathSpec,
                    entry: IndexEntry) -> FileStat:
    return FileStat(name=entry.vfs_name,
                    type=FileType.FILE,
                    content=ContentType.JSON,
                    size=entry.size)


def _database_stat(match: ScopeMatch, path: PathSpec,
                   entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        modified=entry.remote_time or None,
        extra={"database_id": entry.id},
    )


def _database_json_stat(match: ScopeMatch, path: PathSpec,
                        entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.JSON,
        size=entry.size,
        extra={"database_id": match.slots["database_id"]},
    )


def _data_source_stat(match: ScopeMatch, path: PathSpec,
                      entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        modified=entry.remote_time or None,
        extra={"data_source_id": entry.id},
    )


def _data_source_json_stat(match: ScopeMatch, path: PathSpec,
                           entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.JSON,
        size=entry.size,
        extra={"data_source_id": match.slots["data_source_id"]},
    )


def _rows_jsonl_stat(match: ScopeMatch, path: PathSpec,
                     entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=entry.size,
        extra={"data_source_id": match.slots["data_source_id"]},
    )


stat = make_stat(
    detect_scope,
    readdir,
    overrides={"row": _row_stat},
    entry_stats={
        "page": _page_stat,
        "page_json": _page_json_stat,
        "row_json": _page_json_stat,
        "database": _database_stat,
        "database_json": _database_json_stat,
        "data_source": _data_source_stat,
        "data_source_json": _data_source_json_stat,
        "rows_jsonl": _rows_jsonl_stat,
    },
)
