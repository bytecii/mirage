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

from collections.abc import Awaitable, Callable, Iterator

from mirage.shell.escapes import unescape_unquoted
from mirage.shell.helpers import get_text
from mirage.shell.types import TSNodeLike


def _atoms(node: TSNodeLike) -> Iterator[TSNodeLike]:
    if node.type == "concatenation":
        for child in node.children:
            yield from _atoms(child)
    elif node.is_named and node.type not in ("word", "number"):
        yield node


def _separator(data: bytes, start: int, end: int, atoms: list[TSNodeLike],
               base: int) -> int:
    opaque = {atom.start_byte - base: atom.end_byte - base for atom in atoms}
    depth = 0
    ternary = 0
    index = start
    while index < end:
        if index in opaque:
            index = opaque[index]
            continue
        byte = data[index]
        if byte == ord("\\"):
            index += 2
            continue
        if byte in b"([":
            depth += 1
        elif byte in b")]":
            depth -= 1
        elif depth == 0:
            if byte == ord("?"):
                ternary += 1
            elif byte == ord(":"):
                if ternary == 0:
                    return index
                ternary -= 1
        index += 1
    return end


async def substring_operands(
    node: TSNodeLike,
    expand_child: Callable[[TSNodeLike], Awaitable[str]],
) -> list[str]:
    """Split offset and length before expanding their nested words.

    The separator belongs to source syntax, never to substituted text.
    Colons inside quotes, substitutions, parentheses, subscripts and ternary
    expressions cannot split the operands. Both scalar and array slicing use
    this path; the arithmetic evaluator owns validation and side effects.

    Args:
        node (TSNodeLike): substring expansion parsed with word operands.
        expand_child (Callable): evaluator for nested words.
    """
    operator = next(c for c in node.children if get_text(c) == ":")
    children = [
        c for c in node.children
        if c.start_byte >= operator.end_byte and c.type != "}"
    ]
    atoms = [atom for child in children for atom in _atoms(child)]
    data = node.text or b""
    start = operator.end_byte - node.start_byte
    end = len(data) - 1
    separator = _separator(data, start, end, atoms, node.start_byte)
    spans = [(start, separator)]
    if separator < end:
        spans.append((separator + 1, end))
    values = []
    for begin, stop in spans:
        pieces = []
        cursor = begin
        for atom in atoms:
            left = atom.start_byte - node.start_byte
            right = atom.end_byte - node.start_byte
            if begin <= left and right <= stop:
                pieces.append(unescape_unquoted(data[cursor:left].decode()))
                pieces.append(await expand_child(atom))
                cursor = right
        pieces.append(unescape_unquoted(data[cursor:stop].decode()))
        values.append("".join(pieces))
    return values
