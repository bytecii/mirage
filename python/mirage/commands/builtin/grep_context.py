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

import re
from collections import deque
from collections.abc import AsyncIterator

from mirage.commands.builtin.grep_offsets import (decode_line, encode_line,
                                                  prefix_of)
from mirage.io.async_line_iterator import AsyncLineIterator

_SEPARATOR = b"--\n"


class ContextRenderer:
    """grep's context output, settled one line at a time.

    Selected lines and their context, grouped the way GNU groups them,
    with ``--`` between groups. It holds only the last ``before_context``
    lines nothing has printed yet, and ``finished`` turns true once -m has
    selected its last line and that line's trailing context is out, so a
    caller feeding it a stream can stop reading there: a pipe that goes on
    past the answer is never waited on.

    Args:
        pat (re.Pattern[str]): the compiled pattern.
        invert (bool): -v, select the lines that do not match.
        line_numbers (bool): -n, prefix each line with its number.
        max_count (int | None): -m, stop after this many selected lines.
        after_context (int): -A, trailing context lines.
        before_context (int): -B, leading context lines.
        byte_offsets (bool): -b, prefix each line with the byte offset of
            its own start. A context line renders it with ``-`` like
            every other field, and the ``--`` group separator carries no
            fields at all. The rendered line is put back with
            ``encode_line``, so a byte that is not valid UTF-8 prints as
            GNU prints it rather than as U+FFFD.
        label (str | None): the file name every line leads with, followed
            by ``:`` on a selected line and ``-`` on a context line; the
            ``--`` separator carries none.
        trailing_matches (bool): once -m has selected its last line, a
            line in that line's trailing context that would be selected
            prints as selected, still counted as context, the way
            ripgrep prints it; GNU prints it as context.
    """

    def __init__(self,
                 pat: re.Pattern[str],
                 invert: bool,
                 line_numbers: bool,
                 max_count: int | None,
                 after_context: int,
                 before_context: int,
                 byte_offsets: bool = False,
                 label: str | None = None,
                 trailing_matches: bool = False) -> None:
        self._pat = pat
        self._invert = invert
        self._line_numbers = line_numbers
        self._max_count = max_count
        self._after_context = after_context
        self._byte_offsets = byte_offsets
        self._label = label
        self._trailing_matches = trailing_matches
        self._held: deque[tuple[int, str, int]] = deque(maxlen=before_context)
        self._index = -1
        self._position = 0
        self._selected = 0
        self._last_printed = -1
        self._after_left = 0
        # GNU selects no line at all under -m0, context and all, so there is
        # nothing to group and nothing to print.
        self.finished = max_count == 0

    def feed(self, line: str, width: int) -> list[bytes]:
        """Render what one more line settles.

        Args:
            line (str): the next line from ``decode_line``, terminator
                stripped, which is what makes its -b offset exact.
            width (int): the line's length in bytes.
        """
        self._index += 1
        start = self._position
        self._position += width + 1
        out: list[bytes] = []
        selecting = (self._max_count is None
                     or self._selected < self._max_count)
        hit = bool(self._pat.search(line)) != self._invert
        if selecting and hit:
            self._selected += 1
            first = self._held[0][0] if self._held else self._index
            if self._last_printed >= 0 and first > self._last_printed + 1:
                out.append(_SEPARATOR)
            out.extend(
                self._render(number, text, at, False)
                for number, text, at in self._held)
            self._held.clear()
            out.append(self._render(self._index, line, start, True))
            self._last_printed = self._index
            self._after_left = self._after_context
        elif self._after_left > 0:
            out.append(
                self._render(self._index, line, start, hit
                             and self._trailing_matches))
            self._last_printed = self._index
            self._after_left -= 1
        else:
            self._held.append((self._index, line, start))
        if (self._max_count is not None and self._selected >= self._max_count
                and self._after_left == 0):
            self.finished = True
        return out

    def _render(self, index: int, line: str, start: int,
                selected: bool) -> bytes:
        fields = prefix_of(index + 1 if self._line_numbers else None,
                           start if self._byte_offsets else None, selected)
        if self._label is not None:
            fields = f"{self._label}{':' if selected else '-'}{fields}"
        return encode_line(f"{fields}{line}\n")


def grep_context_lines(
    lines: list[str],
    pat: re.Pattern[str],
    invert: bool,
    line_numbers: bool,
    max_count: int | None,
    after_context: int,
    before_context: int,
    byte_offsets: bool = False,
    label: str | None = None,
    trailing_matches: bool = False,
) -> list[bytes]:
    """Render selected lines with their context, GNU's separators included.

    Args:
        lines (list[str]): the whole input, terminators stripped, from
            ``decode_line``: the -b offsets are counted back out of the
            text, which is exact only for text read that way.
        pat (re.Pattern[str]): the compiled pattern.
        invert (bool): -v, select the lines that do not match.
        line_numbers (bool): -n, prefix each line with its number.
        max_count (int | None): -m, stop after this many selected lines.
        after_context (int): -A, trailing context lines.
        before_context (int): -B, leading context lines.
        byte_offsets (bool): -b, see ``ContextRenderer``.
        label (str | None): the file name, see ``ContextRenderer``.
        trailing_matches (bool): ripgrep's -m, see ``ContextRenderer``.
    """
    renderer = ContextRenderer(pat, invert, line_numbers, max_count,
                               after_context, before_context, byte_offsets,
                               label, trailing_matches)
    out: list[bytes] = []
    for line in lines:
        if renderer.finished:
            break
        out.extend(renderer.feed(line, len(encode_line(line))))
    return out


async def grep_context_stream(
    source: AsyncIterator[bytes],
    pat: re.Pattern[str],
    invert: bool,
    line_numbers: bool,
    max_count: int | None,
    after_context: int,
    before_context: int,
    byte_offsets: bool = False,
    label: str | None = None,
    trailing_matches: bool = False,
) -> AsyncIterator[bytes]:
    """``grep_context_lines`` over a stream, read no further than it prints.

    Args:
        source (AsyncIterator[bytes]): the input's bytes.
        pat (re.Pattern[str]): the compiled pattern.
        invert (bool): -v, select the lines that do not match.
        line_numbers (bool): -n, prefix each line with its number.
        max_count (int | None): -m, stop after this many selected lines.
        after_context (int): -A, trailing context lines.
        before_context (int): -B, leading context lines.
        byte_offsets (bool): -b, see ``ContextRenderer``.
        label (str | None): the file name, see ``ContextRenderer``.
        trailing_matches (bool): ripgrep's -m, see ``ContextRenderer``.
    """
    renderer = ContextRenderer(pat, invert, line_numbers, max_count,
                               after_context, before_context, byte_offsets,
                               label, trailing_matches)
    if renderer.finished:
        return
    async for raw in AsyncLineIterator(source):
        for chunk in renderer.feed(decode_line(raw), len(raw)):
            yield chunk
        if renderer.finished:
            return
