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

from urllib.parse import quote

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.core.onedrive._client import (graph_list, graph_post, item_url,
                                          split_path)
from mirage.types import PathSpec


async def list_versions(accessor: OneDriveAccessor,
                        path: PathSpec) -> list[dict]:
    _, stripped = split_path(path)
    url = item_url(accessor.config, "/" + stripped, action="/versions")
    return await graph_list(accessor.config, url)


async def current_version_id(accessor: OneDriveAccessor,
                             path: PathSpec) -> str | None:
    versions = await list_versions(accessor, path)
    if not versions:
        return None
    return versions[0].get("id")


async def restore_version(accessor: OneDriveAccessor, path: PathSpec,
                          version_id: str) -> None:
    _, stripped = split_path(path)
    action = f"/versions/{quote(version_id, safe='')}/restoreVersion"
    url = item_url(accessor.config, "/" + stripped, action=action)
    await graph_post(accessor.config, url)
