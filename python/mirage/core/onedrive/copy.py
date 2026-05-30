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

import posixpath

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.core.onedrive._client import (drive_ref_path, graph_post, item_url,
                                          split_path)
from mirage.types import PathSpec


async def copy(accessor: OneDriveAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    _, src_s = split_path(src)
    _, dst_s = split_path(dst)
    dst_parent = posixpath.dirname("/" + dst_s).strip("/")
    name = posixpath.basename(dst_s)
    url = item_url(accessor.config, "/" + src_s, action="/copy")
    body = {
        "name": name,
        "parentReference": {
            "path": drive_ref_path(accessor.config, dst_parent)
        },
    }
    await graph_post(accessor.config, url, body)
