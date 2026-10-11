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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.msgraph.drive import DriveLoc
from mirage.core.msgraph.search import files_containing as graph_files
from mirage.core.sharepoint.readdir import readdir
from mirage.core.sharepoint.resolve import drive_loc, resolve
from mirage.types import PathSpec


async def files_containing(
    accessor: SharePointAccessor,
    text: str,
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    """The files under ``under`` SharePoint search names.

    Search runs within one document library, so a scope above one (the
    sites, or a site's libraries) answers None. See
    ``mirage.core.msgraph.search.files_containing`` for the files the
    answer can leave out.

    Args:
        accessor (SharePointAccessor): backend handle.
        text (str): the whole word searched for.
        under (list[PathSpec]): the directories walked.
        index (IndexCacheStore): the mount's index.
    """
    scopes: list[tuple[PathSpec, DriveLoc]] = []
    for directory in under:
        resolved = await resolve(accessor, directory)
        if resolved.level not in ("drive", "item") or not resolved.drive_id:
            return None
        loc = drive_loc(accessor.config, resolved, directory.vfs_path)
        scopes.append((directory, loc))
    return await graph_files(
        accessor.config,
        readdir,
        accessor,
        scopes,
        text,
        index,
        session=accessor.pool,
    )
