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

from collections.abc import AsyncIterator

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.read import read_bytes as _read_bytes
from mirage.core.databricks_volume.readdir import readdir as _readdir
from mirage.core.databricks_volume.stat import stat as _stat
from mirage.core.databricks_volume.stream import read_stream as _read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="databricks_volume", spec=SPECS["rg"])
async def rg(
    accessor: DatabricksVolumeAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    resolved = await resolve_glob(accessor, paths, index) if paths else []
    return await generic_rg(
        resolved,
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=_read_bytes,
        read_stream=_read_stream,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )
