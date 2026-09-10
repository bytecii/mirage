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

from collections.abc import Mapping
from typing import Any

from mirage.resource.qdrant.config import QdrantConfig
from mirage.utils.naming import fit_id_name, parse_id_name
from mirage.utils.sanitize import byte_len, path_safe_name


def field_value(row: Mapping[str, Any], field: str | None) -> Any:
    """Read a Qdrant payload field, including dotted nested keys.

    Qdrant spells nested payload paths with dots in filters. Mirroring that
    spelling in config means ``metadata.source`` addresses
    ``{"metadata": {"source": ...}}`` everywhere the mount reads a field.

    Args:
        row (Mapping[str, Any]): point payload plus Mirage's synthetic fields.
        field (str | None): configured payload path.
    """
    if not field:
        return None
    if "." not in field:
        return row.get(field)
    value: Any = row
    for part in field.split("."):
        if not isinstance(value, Mapping) or part not in value:
            return None
        value = value[part]
    return value


def without_field(row: Mapping[str, Any], field: str | None) -> dict[str, Any]:
    """Copy a payload while removing one dotted field path."""
    copied = dict(row)
    if not field:
        return copied
    parts = field.split(".")
    if len(parts) == 1:
        copied.pop(field, None)
        return copied
    source: Any = row
    target: dict[str, Any] = copied
    for part in parts[:-1]:
        if not isinstance(source, Mapping):
            return copied
        child = source.get(part)
        if not isinstance(child, Mapping):
            return copied
        cloned = dict(child)
        target[part] = cloned
        source = child
        target = cloned
    target.pop(parts[-1], None)
    return copied


SEPARATOR = "∕"
ESCAPE = "⁄"


def group_name(value: Any, *, basename: bool = False) -> str:
    """Render one payload value as a VFS segment.

    ``/`` renders as ``∕`` (U+2215), the ``path_safe_name`` convention
    every backend shares. A value that already holds ``∕`` or ``⁄``
    (U+2044) gets that character prefixed with ``⁄``, so no two values
    render as one segment and ``group_value`` inverts the rendering
    exactly. Without the escape ``a/b`` and ``a∕b`` would list as the
    same directory, and descending into it would filter for only one.

    Args:
        value (Any): raw payload value.
        basename (bool): strip URL/path parents before path escaping.
    """
    name = str(value)
    if basename:
        without_query = name.split("#", 1)[0].split("?", 1)[0]
        trimmed = without_query.rstrip("/\\")
        leaf = trimmed.replace("\\", "/").rsplit("/", 1)[-1]
        if leaf:
            name = leaf
    escaped = name.replace(ESCAPE, ESCAPE + ESCAPE)
    escaped = escaped.replace(SEPARATOR, ESCAPE + SEPARATOR)
    return path_safe_name(escaped)


def group_value(name: str) -> str:
    """Undo ``group_name`` for a non-basename segment.

    ``∕`` reads as ``/`` and ``⁄`` as an escape for the character after
    it. A basename segment is never decoded: stripping the parents is
    lossy, so the lister resolves it against the payload instead.

    Args:
        name (str): the rendered segment a path spelled.
    """
    chars: list[str] = []
    escaped = False
    for char in name:
        if escaped:
            chars.append(char)
            escaped = False
        elif char == ESCAPE:
            escaped = True
        elif char == SEPARATOR:
            chars.append("/")
        else:
            chars.append(char)
    if escaped:
        chars.append(ESCAPE)
    return "".join(chars)


def row_stem(row: Mapping[str, Any], config: QdrantConfig) -> str:
    """Return the stable, human-readable stem for a point's files."""
    # The point id is synthetic rather than payload data: _point_to_row stores
    # it under the configured key verbatim, even when that key contains dots.
    # Reading it through field_value would mistake a dotted id_field for a
    # nested payload path.
    point_id = str(row.get(config.id_field))
    label = field_value(row, config.name_field)
    if label is None:
        return point_id
    suffixes = [".json"]
    if config.text_field:
        suffixes.append(".txt")
    if config.blob_field:
        suffixes.append(f".{config.blob_ext}")
    longest_suffix = max(suffixes, key=byte_len)
    fitted = fit_id_name(path_safe_name(str(label)), point_id, longest_suffix)
    return fitted[:-len(longest_suffix)]


def point_id_from_stem(stem: str, config: QdrantConfig) -> str:
    """Recover the opaque Qdrant point id from a VFS file stem."""
    if not config.name_field:
        return stem
    try:
        _, point_id = parse_id_name(stem)
    except FileNotFoundError:
        # A point missing the optional naming payload still lists by id.
        return stem
    return point_id
