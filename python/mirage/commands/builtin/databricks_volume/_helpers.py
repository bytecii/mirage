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
from typing import Callable

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.utils.wrap import (call_read_bytes,
                                                call_read_stream)
from mirage.core.databricks_volume.read import read_bytes as _read_bytes
from mirage.core.databricks_volume.readdir import readdir as _readdir
from mirage.core.databricks_volume.stat import stat as _stat
from mirage.core.databricks_volume.stream import read_stream as _read_stream
from mirage.types import FileType, PathSpec


def path_prefix(paths: list[PathSpec],
                fallback: PathSpec | None = None) -> str:
    if paths:
        return paths[0].prefix
    if fallback is not None:
        return fallback.prefix
    return ""


def is_dir_name(_child: str) -> bool | None:
    # Databricks readdir returns slash-less paths, so classification always
    # falls back to stat (which the walker resolves via the index cache).
    return None


async def find_files(
    accessor: DatabricksVolumeAccessor,
    index: IndexCacheStore | None,
    path: PathSpec | str,
    *,
    type: str | None = None,
) -> list[str]:
    """List paths beneath a search root in mount-relative form.

    Args:
        accessor (DatabricksVolumeAccessor): Databricks accessor.
        index (IndexCacheStore | None): Index cache for readdir and stat.
        path (PathSpec | str): Search root; a file root yields itself.
        type (str | None): "f" (file) or "d" (directory) filter.
    """
    spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                            directory=path)
    file_stat = await _stat(accessor, spec, index)
    if file_stat.type != FileType.DIRECTORY:
        return [spec.strip_prefix]
    args = parse_find_args((), type=type)
    results = await walk_find(spec,
                              readdir=partial(_readdir, accessor),
                              stat=partial(_stat, accessor),
                              is_dir_name=is_dir_name,
                              index=index,
                              args=args)
    prefix = spec.prefix
    return [
        p[len(prefix):] if prefix and p.startswith(prefix) else p
        for p in results
    ]


def read_bytes_with_index(index: IndexCacheStore | None,
                          prefix: str = "") -> Callable:
    return partial(call_read_bytes, _read_bytes, index=index, prefix=prefix)


def read_stream_with_index(index: IndexCacheStore | None,
                           prefix: str = "") -> Callable:
    return partial(call_read_stream, _read_stream, index=index, prefix=prefix)
