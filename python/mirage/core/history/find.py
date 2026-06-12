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

from fnmatch import fnmatch

from mirage.accessor.history import HistoryAccessor
from mirage.core.history.read import VIEW_KEYS, VIEW_NAME, read
from mirage.types import FindType, PathSpec


async def find(
    accessor: HistoryAccessor,
    path: PathSpec,
    name: str | None = None,
    type: FindType | str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
) -> list[str]:
    """find_core over the single-file view: match the view or nothing.

    Args:
        accessor (HistoryAccessor): Accessor holding the recorder.
        path (PathSpec): Search root; only the view file resolves.
        name (str | None): fnmatch pattern on the file name.
        type (FindType | str | None): Type filter; "d" never matches.
        min_size (int | None): Minimum rendered size in bytes.
        max_size (int | None): Maximum rendered size in bytes.
        maxdepth (int | None): Ignored; the view has depth 0.
        name_exclude (str | None): `-not -name` pattern.
        or_names (list[str] | None): `-o -name` alternatives.
        iname (str | None): Case-insensitive name pattern.
        path_pattern (str | None): fnmatch pattern on the full path.
        mindepth (int | None): Filters out the view when > 0.

    Returns:
        list[str]: The view path relative to the mount, or empty.
    """
    key = path.strip_prefix if isinstance(path, PathSpec) else path
    if key.strip("/") not in VIEW_KEYS:
        raise FileNotFoundError(key)
    if type == FindType.DIRECTORY or type == "d":
        return []
    if mindepth is not None and mindepth > 0:
        return []
    if name is not None and not fnmatch(VIEW_NAME, name):
        return []
    if iname is not None and not fnmatch(VIEW_NAME.lower(), iname.lower()):
        return []
    if name_exclude is not None and fnmatch(VIEW_NAME, name_exclude):
        return []
    if or_names and not any(fnmatch(VIEW_NAME, p) for p in or_names):
        return []
    full = path.original if isinstance(path, PathSpec) else path
    if path_pattern is not None and not fnmatch(full, path_pattern):
        return []
    if min_size is not None or max_size is not None:
        size = len(await read(accessor, path))
        if min_size is not None and size < min_size:
            return []
        if max_size is not None and size > max_size:
            return []
    return [""]
