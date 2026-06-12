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

from typing import Awaitable, Callable

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.copy import (backend_key_default,
                                                copy_targets, is_directory,
                                                path_exists)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def mv(
    paths: list[PathSpec],
    *,
    rename: Callable[..., Awaitable[None]],
    stat: Callable[..., Awaitable[object]],
    n: bool,
    v: bool,
    index: IndexCacheStore | None = None,
    backend_key: Callable[[PathSpec], str] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Move sources to a destination, fanning out into a directory.

    Args:
        paths (list[PathSpec]): Source operands followed by the destination.
        rename (Callable): Renames a single source to a target.
        stat (Callable): Stats a path; raises when missing.
        n (bool): No-clobber; skip targets that already exist.
        v (bool): Verbose; emit one ``src -> target`` line per move.
        index (IndexCacheStore | None): Cache for the destination dir probe.
        backend_key (Callable | None): Maps a path to its backend storage key
            for the same-file and into-own-subtree guards; defaults to the
            normalized mount-relative path.

    Returns:
        tuple[ByteSource | None, IOResult]: Verbose output and recorded
        writes, with per-source coreutils errors on stderr and exit code 1
        when any source failed.
    """
    key_of = backend_key if backend_key is not None else backend_key_default
    *sources, dst = paths
    dst_is_dir = await is_directory(stat, dst, index)
    writes: dict[str, bytes] = {}
    lines: list[str] = []
    errors: list[str] = []
    for src, target in copy_targets(sources, dst, dst_is_dir):
        if not await path_exists(stat, src):
            errors.append(f"mv: cannot stat '{src.original}': "
                          "No such file or directory")
            continue
        if key_of(src) == key_of(target):
            errors.append(f"mv: '{src.original}' and '{target.original}' "
                          "are the same file")
            continue
        if key_of(target).startswith(key_of(src) + "/"):
            errors.append(f"mv: cannot move '{src.original}' to a "
                          f"subdirectory of itself, '{target.original}'")
            continue
        if n and await path_exists(stat, target):
            continue
        await rename(src, target)
        writes[src.strip_prefix] = b""
        writes[target.strip_prefix] = b""
        if v:
            lines.append(f"'{src.original}' -> '{target.original}'")
    output = "\n".join(lines) + "\n" if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output.encode() if output else None, IOResult(
        writes=writes,
        stderr=stderr,
        exit_code=1 if errors else 0,
    )
