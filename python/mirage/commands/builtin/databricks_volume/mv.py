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

from functools import partial

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.mv import mv as generic_mv
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.rename import rename as rename_core
from mirage.core.databricks_volume.stat import stat as stat_core
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("mv", resource="databricks_volume", spec=SPECS["mv"], write=True)
async def mv(
    accessor: DatabricksVolumeAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    f: bool = False,
    n: bool = False,
    v: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) < 2:
        raise ValueError("mv: requires src and dst")
    paths = await resolve_glob(accessor, paths, index)
    return await generic_mv(paths,
                            rename=partial(rename_core, accessor, index=index),
                            stat=partial(stat_core, accessor),
                            n=n,
                            v=v,
                            index=index,
                            backend_key=partial(backend_path, accessor.config))
