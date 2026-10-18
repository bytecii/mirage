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

from collections.abc import Callable, Iterable, Sequence

from mirage.commands.cli.builtin.git.errors import (
    FormatUsageError,
    GitError,
    UnparsableFormatError,
)
from mirage.commands.cli.builtin.git.ref_fields import (
    field_value,
    parse_field,
)
from mirage.commands.cli.builtin.git.types import (
    FieldValue,
    QuoteStyle,
    RefContext,
    RefField,
    RefFormat,
    RefItem,
    RefKind,
    RefSortKey,
)
from mirage.shell.bytes import byte_char
from mirage.utils.strverscmp import strverscmp
from mirage.utils.width import text_width

HEX_DIGITS = "0123456789abcdefABCDEF"
BLOCK_FIELDS = frozenset(("align", "if", "then", "else", "end"))
SPACE = " \t\n\v\f\r"
# The quoting styles that cannot carry a raw object's bytes.
TEXT_QUOTES = (QuoteStyle.SHELL, QuoteStyle.PYTHON, QuoteStyle.TCL)
TCL_ESCAPES = {
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\v": "\\v",
}
VERSION_PREFIXES = ("version:", "v:")
# The sort a listing gets when the line names none: by name, upward.
DEFAULT_KEY = "refname"


def literal_text(text: str) -> str:
    """A format's text between fields: ``%%`` is a percent sign and
    ``%`` with two hex digits the byte they spell; any other ``%`` is
    itself.

    Args:
        text (str): the text as typed.
    """
    out: list[str] = []
    at = 0
    while at < len(text):
        ch = text[at]
        if ch == "%" and text.startswith("%", at + 1):
            out.append("%")
            at += 2
        elif (
            ch == "%"
            and at + 2 < len(text)
            and text[at + 1] in HEX_DIGITS
            and text[at + 2] in HEX_DIGITS
        ):
            out.append(byte_char(int(text[at + 1 : at + 3], 16)))
            at += 3
        else:
            out.append(ch)
            at += 1
    return "".join(out)


def _pieces(template: str) -> tuple[list[str | RefField], int | None]:
    """A template's literal runs and fields, and where an unclosed
    ``%(`` starts, None when every one closes.

    Args:
        template (str): the format.
    """
    pieces: list[str | RefField] = []
    at = 0
    while True:
        start = template.find("%(", at)
        while start != -1 and _escaped(template, at, start):
            start = template.find("%(", start + 1)
        if start == -1:
            if at < len(template):
                pieces.append(literal_text(template[at:]))
            return pieces, None
        end = template.find(")", start)
        if end == -1:
            return pieces, start
        if at < start:
            pieces.append(literal_text(template[at:start]))
        pieces.append(parse_field(template[start + 2 : end]))
        at = end + 1


def _escaped(template: str, at: int, start: int) -> bool:
    """Whether the ``%`` at ``start`` is the second half of a ``%%``
    begun at or after ``at``.

    Args:
        template (str): the format.
        at (int): where the current literal run starts.
        start (int): where ``%(`` was found.
    """
    run = 0
    while start - run - 1 >= at and template[start - run - 1] == "%":
        run += 1
    return run % 2 == 1


def parse_format(
    template: str, quote: QuoteStyle = QuoteStyle.NONE
) -> RefFormat:
    """Read a ``--format`` string once for every ref it renders.

    Args:
        template (str): the format.
        quote (QuoteStyle): the quoting option the line chose.

    Raises:
        FormatUsageError: a ``%(`` that never closes.
        GitError: a field git refuses, or ``%(raw)`` under a quoting
            style that cannot carry its bytes.
    """
    pieces, unclosed = _pieces(template)
    if unclosed is not None:
        raise FormatUsageError(
            f"malformed format string {template[unclosed:]}"
        )
    _check_raw(pieces, quote)
    return RefFormat(pieces=tuple(pieces), quote=quote)


def _check_raw(pieces: Iterable[str | RefField], quote: QuoteStyle) -> None:
    if quote not in TEXT_QUOTES:
        return
    for piece in pieces:
        if (
            isinstance(piece, RefField)
            and piece.name == "raw"
            and not piece.variant
        ):
            raise GitError(
                f"--format={piece.text} cannot be used with --python, --shell, --tcl"
            )


def listing_format(template: str) -> RefFormat:
    """``branch``'s and ``tag``'s ``--format``, which refuse a ``%(``
    that never closes in two lines rather than with the usage.

    Args:
        template (str): the format.

    Raises:
        UnparsableFormatError: a ``%(`` that never closes.
        GitError: a field git refuses.
    """
    pieces, unclosed = _pieces(template)
    if unclosed is not None:
        raise UnparsableFormatError(template[unclosed:])
    return RefFormat(pieces=tuple(pieces))


def used_fields(
    fmt: RefFormat | None, keys: Iterable[RefSortKey]
) -> tuple[RefField, ...]:
    """Every field a listing reads: its format's and its sort keys'.

    Args:
        fmt (RefFormat | None): the format, None for a built-in layout.
        keys (Iterable[RefSortKey]): the sort keys.
    """
    fields = [p for p in fmt.pieces if isinstance(p, RefField)] if fmt else []
    return (*fields, *(key.field for key in keys))


def parse_sort_keys(spellings: Sequence[str]) -> tuple[RefSortKey, ...]:
    """The ``--sort`` keys, the last given first, as git orders them.

    Each is an optional ``-`` (descending), then an optional
    ``version:`` or ``v:``, then a field.

    Args:
        spellings (Sequence[str]): the keys in line order.

    Raises:
        GitError: a key whose field git refuses.
    """
    keys = []
    for spelling in reversed(spellings):
        reverse = spelling.startswith("-")
        rest = spelling[1:] if reverse else spelling
        prefix = next((p for p in VERSION_PREFIXES if rest.startswith(p)), "")
        keys.append(
            RefSortKey(
                field=parse_field(rest[len(prefix) :]),
                reverse=reverse,
                version=bool(prefix),
            )
        )
    return tuple(keys)


def quote_text(text: str, style: QuoteStyle) -> str:
    """One field's text quoted for the language a quoting option names.

    Args:
        text (str): the text.
        style (QuoteStyle): the quoting style.
    """
    if style is QuoteStyle.SHELL:
        return "'" + text.replace("'", "'\\''").replace("!", "'\\!'") + "'"
    if style is QuoteStyle.PERL:
        return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if style is QuoteStyle.PYTHON:
        escaped = text.replace("\\", "\\\\").replace("'", "\\'")
        return "'" + escaped.replace("\n", "\\n") + "'"
    if style is QuoteStyle.TCL:
        out = []
        for ch in text:
            if ch in '[]{}$\\"':
                out.append("\\" + ch)
            else:
                out.append(TCL_ESCAPES.get(ch, ch))
        return '"' + "".join(out) + '"'
    return text


def _common_prefix(a: str, b: str) -> int:
    """How many leading characters two names share."""
    at = 0
    while at < len(a) and at < len(b) and a[at] == b[at]:
        at += 1
    return at


def _suffix_rank(name: str, off: int, suffixes: Sequence[str]) -> int | None:
    """Which configured suffix decides where ``name`` sorts: of those
    starting at or before the first difference and reaching it, the one
    starting earliest, then the longest, then the first configured.

    Args:
        name (str): one of the two names compared.
        off (int): where the two names first differ.
        suffixes (Sequence[str]): ``versionsort.suffix``, in order.
    """
    best: tuple[int, int, int] | None = None
    for rank, suffix in enumerate(suffixes):
        if not suffix:
            continue
        at = name.find(suffix)
        while at != -1 and at <= off:
            if at + len(suffix) >= off:
                candidate = (at, -len(suffix), rank)
                if best is None or candidate < best:
                    best = candidate
            at = name.find(suffix, at + 1)
    return None if best is None else best[2]


def versioncmp(a: str, b: str, suffixes: Sequence[str] = ()) -> int:
    """Version order with ``versionsort.suffix``.

    A name holding one of the suffixes where the two first differ sorts
    before one holding none, and two holding different ones sort in the
    order the suffixes were configured; an empty suffix in the list
    places the names holding none. Anything else is ``strverscmp``.
    Fitted to git 2.47.3 on 40,950 pairs of names.

    Args:
        a (str): the first name.
        b (str): the second name.
        suffixes (Sequence[str]): ``versionsort.suffix``, in order.
    """
    if suffixes and a != b:
        off = _common_prefix(a, b)
        rank_a = _suffix_rank(a, off, suffixes)
        rank_b = _suffix_rank(b, off, suffixes)
        if "" in suffixes:
            empty = suffixes.index("")
            rank_a = empty if rank_a is None else rank_a
            rank_b = empty if rank_b is None else rank_b
        if rank_a != rank_b:
            if rank_a is None:
                return 1
            if rank_b is None:
                return -1
            return -1 if rank_a < rank_b else 1
    return strverscmp(a, b)


class ValueTable:
    """Each field's value for each ref, read once however often a sort
    or a row asks.

    Args:
        fields (Iterable[RefField]): the fields the listing reads.
        ctx (RefContext): the listing's facts.
    """

    def __init__(self, fields: Iterable[RefField], ctx: RefContext) -> None:
        self.fields = tuple(fields)
        self.ctx = ctx
        self._values: dict[tuple[str, str], dict[RefField, FieldValue]] = {}

    def value(self, item: RefItem, field: RefField) -> FieldValue:
        """One field's value for one ref.

        A ref's first read reads every field the listing uses, so one
        refused for the ref stops the listing whichever field was asked
        for, as git's does.

        Args:
            item (RefItem): the ref.
            field (RefField): the field.
        """
        key = (item.name, item.kind.value)
        row = self._values.get(key)
        if row is None:
            row = {
                used: self._read(item, used)
                for used in dict.fromkeys(self.fields)
            }
            self._values[key] = row
        found = row.get(field)
        if found is None:
            found = row[field] = self._read(item, field)
        return found

    def _read(self, item: RefItem, field: RefField) -> FieldValue:
        if field.name in BLOCK_FIELDS:
            return FieldValue("")
        return field_value(field, item, self.ctx)


def display_width(text: str) -> int:
    """How many terminal columns a name takes.

    Args:
        text (str): the text.
    """
    return text_width(text)


def _ascii_folded(text: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in text)


def _order(a: str, b: str) -> int:
    return (a > b) - (a < b)


def _compare(
    key: RefSortKey,
    a: FieldValue,
    b: FieldValue,
    ctx: RefContext,
    icase: bool,
) -> int:
    if key.version:
        return versioncmp(a.text, b.text, ctx.suffixes)
    if a.number is not None and b.number is not None:
        return (a.number > b.number) - (a.number < b.number)
    if icase:
        return _order(_ascii_folded(a.text), _ascii_folded(b.text))
    return _order(a.text, b.text)


def _merge_sort(
    items: list[RefItem], compare: Callable[[RefItem, RefItem], int]
) -> list[RefItem]:
    """A top-down merge sort, halves split at ``n // 2`` and a tie taken
    from the left, so the comparisons come in the order git's make them.

    Args:
        items (list[RefItem]): the refs, in name order.
        compare (Callable[[RefItem, RefItem], int]): the order.
    """
    if len(items) <= 1:
        return items
    half = len(items) // 2
    left = _merge_sort(items[:half], compare)
    right = _merge_sort(items[half:], compare)
    out: list[RefItem] = []
    i = j = 0
    while i < len(left) and j < len(right):
        if compare(left[i], right[j]) <= 0:
            out.append(left[i])
            i += 1
        else:
            out.append(right[j])
            j += 1
    return [*out, *left[i:], *right[j:]]


def sort_refs(
    items: Sequence[RefItem],
    keys: Sequence[RefSortKey],
    table: ValueTable,
    ctx: RefContext,
    icase: bool,
    detached_first: bool = False,
) -> list[RefItem]:
    """The refs in the order the keys give, the first key deciding
    first; a tie on every key goes by name, upward whatever the keys'
    direction. A detached HEAD leads when ``detached_first`` says so.

    The sort's first comparison of a date with a style
    (``committerdate:short``), under whichever key, goes by the refs'
    instants, and every later one by the dates as shown, as git's sort
    does (measured on 504 random ref sets and eight styles against git
    2.47.3 and 2.50.1, and on 1,800 random lists of up to four keys
    against 2.50.1).

    Args:
        items (Sequence[RefItem]): the refs, in name order.
        keys (Sequence[RefSortKey]): the keys, primary first.
        table (ValueTable): the listing's values.
        ctx (RefContext): the listing's facts.
        icase (bool): ``--ignore-case``: text compares ASCII case folded.
        detached_first (bool): put a detached HEAD first.

    Raises:
        GitError: a key's field refused for some ref.
    """
    fresh = True

    def compare(a: RefItem, b: RefItem) -> int:
        nonlocal fresh
        if detached_first:
            lead_a = a.kind is RefKind.DETACHED
            lead_b = b.kind is RefKind.DETACHED
            if lead_a != lead_b:
                return -1 if lead_a else 1
        for key in keys:
            value_a, value_b = (
                table.value(a, key.field),
                table.value(b, key.field),
            )
            if key.field.date is not None:
                if not fresh:
                    value_a = FieldValue(value_a.text)
                    value_b = FieldValue(value_b.text)
                fresh = False
            found = _compare(key, value_a, value_b, ctx, icase)
            if found:
                return -found if key.reverse else found
        if icase:
            return _order(
                _ascii_folded(a.name), _ascii_folded(b.name)
            ) or _order(a.name, b.name)
        return _order(a.name, b.name)

    return _merge_sort(list(items), compare)


class _Block:
    """An ``align`` or ``if`` block being filled while a row renders.

    Args:
        field (RefField): the field that opened it.
    """

    def __init__(self, field: RefField) -> None:
        self.field = field
        self.out: list[str] = []
        self.condition: str | None = None
        self.then: str | None = None


def _holds(field: RefField, condition: str) -> bool:
    argument = field.argument or ""
    if field.variant == "equals":
        return condition == argument[len("equals=") :]
    if field.variant == "notequals":
        return condition != argument[len("notequals=") :]
    return condition.strip(SPACE) != ""


def _aligned(text: str, field: RefField) -> str:
    gap = field.count - text_width(text)
    if gap <= 0:
        return text
    if field.variant == "right":
        return " " * gap + text
    if field.variant == "middle":
        left = gap // 2
        return " " * left + text + " " * (gap - left)
    return text + " " * gap


def _then_atom(blocks: list[_Block]) -> None:
    block = blocks[-1] if blocks else None
    if block is None or block.field.name != "if":
        raise GitError("format: %(then) atom used without a %(if) atom")
    if block.condition is not None:
        raise GitError("format: %(then) atom used more than once")
    block.condition = "".join(block.out)
    block.out = []


def _else_atom(blocks: list[_Block]) -> None:
    block = blocks[-1] if blocks else None
    if block is None or block.field.name != "if":
        raise GitError("format: %(else) atom used without a %(if) atom")
    if block.condition is None:
        raise GitError("format: %(else) atom used without a %(then) atom")
    if block.then is not None:
        raise GitError("format: %(else) atom used more than once")
    block.then = "".join(block.out)
    block.out = []


def _end_atom(blocks: list[_Block]) -> str:
    if not blocks:
        raise GitError("format: %(end) atom used without corresponding atom")
    block = blocks.pop()
    body = "".join(block.out)
    if block.field.name == "align":
        return _aligned(body, block.field)
    if block.condition is None:
        raise GitError("format: %(if) atom used without a %(then) atom")
    then, other = (block.then, body) if block.then is not None else (body, "")
    return then if _holds(block.field, block.condition) else other


def render_row(fmt: RefFormat, item: RefItem, table: ValueTable) -> str:
    """One ref through a format: literal text as it is, each field (or
    each outermost block) quoted on its own.

    Args:
        fmt (RefFormat): the format.
        item (RefItem): the ref.
        table (ValueTable): the listing's values.

    Raises:
        GitError: blocks that do not nest, or a field refused for this
            ref.
    """
    out: list[str] = []
    blocks: list[_Block] = []

    def emit(text: str, quoted: bool) -> None:
        if blocks:
            blocks[-1].out.append(text)
        else:
            out.append(quote_text(text, fmt.quote) if quoted else text)

    for piece in fmt.pieces:
        if isinstance(piece, str):
            emit(piece, False)
        elif piece.name in ("align", "if"):
            blocks.append(_Block(piece))
        elif piece.name == "then":
            _then_atom(blocks)
        elif piece.name == "else":
            _else_atom(blocks)
        elif piece.name == "end":
            emit(_end_atom(blocks), True)
        else:
            emit(table.value(item, piece).text, True)
    if blocks:
        raise GitError("format: %(end) atom missing")
    return "".join(out)


def _default_order(keys: Sequence[RefSortKey]) -> bool:
    return (
        len(keys) == 1
        and keys[0].field.text == DEFAULT_KEY
        and not (keys[0].reverse or keys[0].version)
    )


def format_refs(
    fmt: RefFormat,
    items: Sequence[RefItem],
    ctx: RefContext,
    keys: Sequence[RefSortKey] | None,
    count: int = 0,
    omit_empty: bool = False,
    icase: bool = False,
    detached_first: bool = False,
    stream: bool = True,
) -> tuple[str, GitError | None]:
    """A listing through ``--format``, one row per ref.

    A listing in name order (``--no-sort``, or the one sort a line gets
    by default, case-sensitive) writes each row as it renders, in the order the refs
    came, so a field refused on a later ref stops it with the rows before
    already out; a sorted one renders every row first and prints none
    when one is refused.
    ``--count`` takes refs, an omitted empty row among them.

    Args:
        fmt (RefFormat): the format.
        items (Sequence[RefItem]): the refs, in name order.
        ctx (RefContext): the listing's facts.
        keys (Sequence[RefSortKey] | None): the sort keys, primary first;
            None for ``--no-sort``.
        count (int): ``--count``, 0 for every ref.
        omit_empty (bool): ``--omit-empty``: no line for an empty row.
        icase (bool): ``--ignore-case``.
        detached_first (bool): a detached HEAD leads.
        stream (bool): whether the listing may write rows as it renders,
            which a line naming its sort, or a commit filter that walks
            history first, rules out.

    Returns:
        tuple[str, GitError | None]: the rows printed, and the refusal
        the listing stopped at.
    """
    table = ValueTable(used_fields(fmt, keys or ()), ctx)
    # Case folding reorders even the default sort, so only a
    # case-sensitive one streams.
    streamed = stream and (
        keys is None or (not icase and _default_order(keys))
    )
    try:
        ordered = (
            list(items)
            if keys is None or streamed
            else sort_refs(items, keys, table, ctx, icase, detached_first)
        )
    except GitError as exc:
        return "", exc
    # A streamed listing stops at its count; a sorted one renders every
    # row before the count takes the first.
    rows: list[str] = []
    stopped: GitError | None = None
    for taken, item in enumerate(ordered):
        if streamed and 0 < count <= taken:
            break
        try:
            rows.append(render_row(fmt, item, table))
        except GitError as exc:
            if not streamed:
                return "", exc
            stopped = exc
            break
    if count > 0:
        rows = rows[:count]
    return "".join(
        f"{row}\n" for row in rows if row or not omit_empty
    ), stopped
