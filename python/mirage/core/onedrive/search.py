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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.msgraph.search import files_containing as graph_files
from mirage.core.onedrive.client import drive_loc
from mirage.core.onedrive.readdir import readdir
from mirage.types import PathSpec


async def files_containing(
    accessor: OneDriveAccessor,
    text: str,
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    """The files under ``under`` OneDrive search names.

    See ``mirage.core.msgraph.search.files_containing`` for the files the
    answer can leave out.

    Args:
        accessor (OneDriveAccessor): backend handle.
        text (str): the whole word searched for.
        under (list[PathSpec]): the directories walked.
        index (IndexCacheStore): the mount's index.
    """
    scopes = [(d, drive_loc(accessor.config, d.vfs_path)) for d in under]
    return await graph_files(
        accessor.config,
        readdir,
        accessor,
        scopes,
        text,
        index,
        session=accessor.pool,
    )
