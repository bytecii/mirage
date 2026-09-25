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

import os
from pathlib import Path

from mirage.core.disk.utils import resolve_inside
from mirage.types import PathSpec


def size_sync(root: Path, path: str, spec: PathSpec) -> int:
    """Recursive byte size of a path, run on a worker thread.

    The walk is plain blocking ``os.walk``, which the caller hands to one
    thread with ``asyncio.to_thread``, rather than ``aiofiles``.
    ``aiofiles`` is itself a thread-pool wrapper (each call is a
    ``run_in_executor``), so walking with it costs one hand-off per
    ``listdir`` and ``stat``. On MCP-Atlas's ``/data``, about 6,000
    entries, that took 0.24 s, against 0.034 s for the whole walk in one
    hand-off, and stalled the event loop longer with its callbacks
    (8.8 ms against 1.2 ms). ``aiofiles`` stays the tool for one op on one
    file, where a single hand-off is the least there is.

    Args:
        root (Path): the mount root.
        path (str): mount-relative path.
        spec (PathSpec): the operand, the path a refusal names.
    """
    p = resolve_inside(root, path, spec)
    if p.is_file():
        return p.stat().st_size
    total = 0
    for dirpath, _dirnames, filenames in os.walk(p):
        for f in filenames:
            full = os.path.join(dirpath, f)
            # A host symlink is not an entry of the mount (resolve_inside).
            if os.path.islink(full):
                continue
            try:
                total += os.path.getsize(full)
            except OSError:
                # unreadable entry: GNU du skips it and totals the rest
                pass
    return total


def entries_sync(root: Path, path: str,
                 spec: PathSpec) -> tuple[list[tuple[str, int]], int]:
    """Per-file sizes under a path plus their total, on a worker thread.

    One hand-off for the whole walk rather than ``aiofiles``' one per
    call, for the reason ``size_sync`` gives.

    Args:
        root (Path): the mount root.
        path (str): mount-relative path.
        spec (PathSpec): the operand, the path a refusal names.
    """
    p = resolve_inside(root, path, spec)
    if p.is_file():
        file_size = p.stat().st_size
        return [(("/" + path.strip("/")), file_size)], file_size
    found: list[tuple[str, int]] = []
    total = 0
    for dirpath, _dirnames, filenames in os.walk(p):
        for f in filenames:
            full = os.path.join(dirpath, f)
            if os.path.islink(full):
                continue
            try:
                file_size = os.path.getsize(full)
            except OSError:
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            found.append(("/" + rel, file_size))
            total += file_size
    found.sort()
    return found, total
