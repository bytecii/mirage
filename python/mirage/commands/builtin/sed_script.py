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

from bisect import bisect_right
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, TypeAlias

from mirage.rs.errors import RegexError
from mirage.rs.regex import PosixRegex
from mirage.shell.bytes import byte_view, decode_text, from_byte_view
from mirage.utils.strverscmp import strverscmp

SED_STDOUT = "/dev/stdout"
SED_STDERR = "/dev/stderr"
# The release whose behaviour this follows; `v` refuses a newer one.
SED_VERSION = "4.9"

_BLANKS = " \t"
_SPACES = " \t\n\v\f\r"
# Under UTF-8 these bytes open a multibyte character, which no
# delimiter may be.
_LEAD_BYTES = ("\xc2", "\xfd")
# What a one-letter escape stands for, in a script's regex, replacement,
# `y` strings and `a`/`i`/`c` text alike.
_CONTROL = {"a": "\a", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v"}
_CASE = frozenset("LUluE")


@dataclass(frozen=True, slots=True)
class SedScriptPiece:
    """One -e expression or -f file of a sed command line.

    Args:
        kind (Literal["expr", "file"]): where the text came from.
        text (str): the script text, as shell text.
        name (str | None): a file's name, for its diagnostics.
    """

    kind: Literal["expr", "file"]
    text: str
    name: str | None = None


class SedError(Exception):
    """A script sed refuses, worded and coded as GNU sed 4.9 refuses it.

    Args:
        message (str): the whole diagnostic, without its newline.
        exit_code (int): sed's exit status for it.
        wfiles (Sequence[str]): the ``w`` files opened before it, which
            GNU has already truncated.
    """

    def __init__(
        self, message: str, exit_code: int = 1, wfiles: Sequence[str] = ()
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.wfiles = list(wfiles)


class AddressKind(Enum):
    LINE = "line"
    LAST = "last"
    REGEX = "regex"
    STEP = "step"
    PLUS = "plus"
    MULTIPLE = "multiple"


@dataclass(slots=True)
class SedRegex:
    """A compiled address or ``s`` expression; ``regex`` None for the
    empty one, which matches as the last expression used."""

    regex: PosixRegex | None


@dataclass(slots=True)
class SedAddress:
    kind: AddressKind
    number: int = 0
    step: int = 0
    regex: SedRegex | None = None


@dataclass(frozen=True, slots=True)
class ReplacementPart:
    """A piece of an ``s`` replacement: ``text`` itself, a ``group``
    (0 for the whole match), or a ``case`` conversion (``L U l u E``)."""

    text: str = ""
    group: int | None = None
    case: str | None = None


@dataclass(slots=True)
class SedSubstitution:
    regex: SedRegex
    parts: list[ReplacementPart]
    global_: bool = False
    occurrence: int = 1
    print_: bool = False
    wfile: str | None = None


@dataclass(slots=True)
class SedCommand:
    """One command: its addresses, its letter and what it carries."""

    name: str
    addr1: SedAddress | None = None
    addr2: SedAddress | None = None
    negate: bool = False
    text: str | None = None
    label: str | None = None
    target: int | None = None
    filename: str | None = None
    number: int | None = None
    subst: SedSubstitution | None = None
    translit: dict[str, str] | None = None
    block_end: int = 0


@dataclass(slots=True)
class SedProgram:
    """A compiled script: its commands in order, the files its ``w``,
    ``r`` and ``R`` commands name in the order they first appear, and
    whether ``#n`` made it quiet."""

    commands: list[SedCommand] = field(default_factory=list)
    wfiles: list[str] = field(default_factory=list)
    rfiles: list[str] = field(default_factory=list)
    reader_files: list[str] = field(default_factory=list)
    quiet: bool = False


def _address(
    kind: AddressKind,
    number: int = 0,
    step: int = 0,
    regex: SedRegex | None = None,
) -> SedAddress:
    return SedAddress(kind, number, step, regex)


def _is_digit(ch: str | None) -> bool:
    return ch is not None and "0" <= ch <= "9"


class _Script:
    """The script's pieces as one text of byte views, joined by newlines,
    read one character at a time, with the place GNU names in a
    diagnostic for the last one read.

    Args:
        pieces (Sequence[SedScriptPiece]): the -e and -f pieces in order.
    """

    def __init__(self, pieces: Sequence[SedScriptPiece]) -> None:
        self.pieces = list(pieces)
        views = [byte_view(piece.text) for piece in self.pieces]
        self.starts: list[int] = []
        at = 0
        for view in views:
            self.starts.append(at)
            at += len(view) + 1
        self.lengths = [len(view) for view in views]
        # The newlines that join one piece to the next, which only text
        # continues across.
        self.joins = {start - 1 for start in self.starts[1:]}
        self.text = "\n".join(views)
        self.pos = 0
        expressions = 0
        self.numbers: list[int] = []
        for piece in self.pieces:
            if piece.kind == "expr":
                expressions += 1
            self.numbers.append(expressions)

    def peek(self) -> str | None:
        return self.text[self.pos] if self.pos < len(self.text) else None

    def get(self) -> str | None:
        ch = self.peek()
        if ch is not None:
            self.pos += 1
        return ch

    def unget(self) -> None:
        self.pos -= 1

    def skip(self, chars: str) -> str | None:
        """Pass over any of ``chars``; the next character after them.

        Args:
            chars (str): the characters to pass over.
        """
        while (ch := self.peek()) is not None and ch in chars:
            self.pos += 1
        return self.peek()

    def where(self, at: int | None = None, char: int | None = None) -> str:
        """GNU's name for a place in the script.

        Args:
            at (int | None): the last character read, by default the
                current one.
            char (int | None): a fixed character count, for the
                diagnostics GNU gives at char 0.
        """
        last = (self.pos if at is None else at) - 1
        index = max(bisect_right(self.starts, max(last, 0)) - 1, 0)
        piece = self.pieces[index]
        offset = last - self.starts[index]
        if piece.kind == "file":
            body = self.text[self.starts[index] : self.starts[index] + offset]
            return f"file {piece.name} line {body.count(chr(10)) + 1}"
        count = (
            char
            if char is not None
            else min(max(offset + 1, 0), self.lengths[index])
        )
        return f"-e expression #{self.numbers[index]}, char {count}"

    def last_where(self) -> str:
        """The end of the last piece, where GNU reports an unclosed
        block."""
        index = len(self.pieces) - 1
        piece = self.pieces[index]
        if piece.kind == "file":
            text = self.text[self.starts[index] :]
            return f"file {piece.name} line {text.count(chr(10)) + 1}"
        return f"-e expression #{self.numbers[index]}, char 0"


_RECURSIVE = "recursive escaping after \\c not allowed"


class _RecursiveEscape(Exception):
    """A ``\\c`` before a backslash that does not stand for itself."""


def _numeric_escape(text: str, at: int, kind: str) -> tuple[str, int] | None:
    """The character a ``\\d``, ``\\o``, ``\\x`` or ``\\c`` escape names.

    Args:
        text (str): the byte view the escape is in.
        at (int): the index of the escape's letter.
        kind (str): the letter.

    Returns:
        tuple[str, int] | None: the character and the index after the
            escape, or None when no digits follow (the escape is then its
            letter).

    Raises:
        _RecursiveEscape: ``\\c\\`` followed by anything but a second
            backslash, which GNU refuses.
    """
    if kind == "c":
        # `\c` at the end stands for a backslash, and `\c\\` is the
        # control character of a backslash.
        if at + 1 >= len(text):
            return "\\", at + 1
        nxt = text[at + 1]
        if nxt == "\\":
            if at + 2 < len(text) and text[at + 2] == "\\":
                return chr(0x1C), at + 3
            raise _RecursiveEscape
        # Only an ASCII letter takes its capital: the text is bytes.
        code = ord(nxt)
        if 0x61 <= code <= 0x7A:
            code -= 0x20
        return chr(code ^ 0x40), at + 2
    base, width, digits = {
        "d": (10, 3, "0123456789"),
        "o": (8, 3, "01234567"),
        "x": (16, 2, "0123456789abcdefABCDEF"),
    }[kind]
    end = at + 1
    while end < len(text) and end - at - 1 < width and text[end] in digits:
        end += 1
    if end == at + 1:
        return None
    return chr(int(text[at + 1 : end], base) & 0xFF), end


def _escape(text: str, at: int) -> tuple[str, int] | None:
    """A sed escape at ``text[at]``, the letter after a backslash.

    Args:
        text (str): the byte view.
        at (int): the index of the letter.

    Returns:
        tuple[str, int] | None: the character and the index after it, or
            None when the letter is no sed escape.
    """
    ch = text[at]
    if ch in _CONTROL:
        return _CONTROL[ch], at + 1
    if ch in "doxc":
        return _numeric_escape(text, at, ch)
    return None


def _regex_text(raw: str) -> str:
    """An expression's text as regcomp gets it from sed: the escapes sed
    reads itself turned into the characters they stand for, which keep
    whatever meaning they have there (``\\x2e`` is any character).

    Args:
        raw (str): the expression between its delimiters, delimiter
            escapes already resolved.
    """
    out: list[str] = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch != "\\" or i + 1 >= len(raw):
            out.append(ch)
            i += 1
            continue
        found = _escape(raw, i + 1)
        if found is None:
            out.append(raw[i : i + 2])
            i += 2
            continue
        out.append(found[0])
        i = found[1]
    return "".join(out)


def _y_text(raw: str) -> str:
    """A ``y`` string's characters: ``\\\\`` a backslash, sed's escapes
    the characters they name, and any other escaped character itself.

    Args:
        raw (str): the string between its delimiters, an escaped
            delimiter already the plain one.
    """
    out: list[str] = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch != "\\" or i + 1 >= len(raw):
            out.append(ch)
            i += 1
            continue
        nxt = raw[i + 1]
        found = None if nxt == "\\" else _escape(raw, i + 1)
        if found is None:
            out.append(nxt)
            i += 2
            continue
        out.append(found[0])
        i = found[1]
    return "".join(out)


class _Compiler:
    """Reads a script into a ``SedProgram`` the way GNU sed 4.9 does.

    Args:
        pieces (Sequence[SedScriptPiece]): the -e and -f pieces.
        extended (bool): -E.
        utf8 (bool): a UTF-8 locale.
    """

    def __init__(
        self, pieces: Sequence[SedScriptPiece], extended: bool, utf8: bool
    ) -> None:
        self.src = _Script(pieces)
        self.extended = extended
        self.utf8 = utf8
        self.program = SedProgram()
        self.blocks: list[int] = []

    def fail(self, message: str, at: int | None = None) -> SedError:
        return SedError(
            f"sed: {self.src.where(at)}: {message}",
            wfiles=self.program.wfiles,
        )

    def fail_at(self, at: int | None, message: str) -> SedError:
        return SedError(
            f"sed: {self.src.where(at)}: {message}",
            wfiles=self.program.wfiles,
        )

    def view(self, raw: str) -> str:
        """A byte view of the script as the machine's view of text.

        Args:
            raw (str): one character per byte.
        """
        return decode_text(from_byte_view(raw)) if self.utf8 else raw

    def compile(self) -> SedProgram:
        src = self.src
        if src.text.startswith("#n"):
            self.program.quiet = True
        while True:
            ch = src.skip(_SPACES + ";")
            if ch is None:
                break
            if ch == "#":
                self.comment()
                continue
            self.command()
        if self.blocks:
            raise SedError(
                f"sed: {src.last_where()}: unmatched `{{'",
                wfiles=self.program.wfiles,
            )
        self.resolve()
        return self.program

    def comment(self) -> None:
        src = self.src
        while (ch := src.get()) is not None and ch != "\n":
            pass

    def resolve(self) -> None:
        labels: dict[str, int] = {}
        for index, cmd in enumerate(self.program.commands):
            if cmd.name == ":" and cmd.label is not None:
                labels.setdefault(cmd.label, index)
        for cmd in self.program.commands:
            if cmd.name not in "btT":
                continue
            if not cmd.label:
                cmd.target = len(self.program.commands)
                continue
            if cmd.label not in labels:
                raise SedError(
                    "sed: can't find label for jump to "
                    f"`{decode_text(from_byte_view(cmd.label))}'",
                    exit_code=4,
                    wfiles=self.program.wfiles,
                )
            cmd.target = labels[cmd.label]

    def number(self) -> int:
        """The digits here, read one at a time and kept to 64 bits as sed
        counts them, so no length of them is refused."""
        src = self.src
        value = 0
        while (ch := src.peek()) is not None and _is_digit(ch):
            value = (value * 10 + ord(ch) - ord("0")) % (1 << 64)
            src.pos += 1
        return value

    def delimiter(self, delim: str) -> None:
        """Refuse a delimiter that opens a multibyte character.

        Args:
            delim (str): the byte just read as the delimiter.
        """
        low, high = _LEAD_BYTES
        if self.utf8 and low <= delim <= high:
            raise self.fail(
                "delimiter character is not a single-byte character"
            )

    def address(self) -> SedAddress | None:
        src = self.src
        ch = src.peek()
        if ch is None:
            return None
        if _is_digit(ch):
            first = self.number()
            if src.skip(_BLANKS) == "~":
                src.get()
                src.skip(_BLANKS)
                step = self.number() if _is_digit(src.peek()) else 0
                # `first~0` is the line `first` itself.
                if step == 0:
                    return _address(AddressKind.LINE, first)
                return _address(AddressKind.STEP, first, step)
            return _address(AddressKind.LINE, first)
        if ch == "$":
            src.get()
            return _address(AddressKind.LAST)
        if ch == "/" or ch == "\\":
            src.get()
            if ch == "\\":
                delim = src.get()
                if delim is None or delim == "\n":
                    raise self.fail("unterminated address regex")
                self.delimiter(delim)
            else:
                delim = "/"
            raw = self.delimited(delim, "unterminated address regex")
            icase = multiline = False
            while (flag := src.skip(_BLANKS)) in ("I", "M"):
                src.get()
                if flag == "I":
                    icase = True
                else:
                    multiline = True
            return _address(
                AddressKind.REGEX, regex=self.regex(raw, icase, multiline)
            )
        return None

    def second_address(self) -> SedAddress:
        src = self.src
        ch = src.skip(_BLANKS)
        if ch in ("+", "~"):
            src.get()
            src.skip(_BLANKS)
            if not _is_digit(src.peek()):
                src.get()
                raise self.fail("unexpected `,'")
            kind = AddressKind.PLUS if ch == "+" else AddressKind.MULTIPLE
            return _address(kind, self.number())
        found = self.address()
        if found is None:
            src.get()
            raise self.fail("unexpected `,'")
        return found

    def delimited(self, delim: str, unterminated: str) -> str:
        """The text up to an unescaped ``delim``, bracket expressions
        read whole, a ``\\delim`` made the plain delimiter and ``\\n``
        a newline.

        Args:
            delim (str): the delimiter.
            unterminated (str): the refusal when the text never ends.
        """
        src = self.src
        out: list[str] = []
        while True:
            ch = src.get()
            if ch is None or ch == "\n":
                raise self.fail(unterminated)
            if ch == delim:
                return "".join(out)
            if ch == "\\":
                nxt = src.get()
                if nxt is None or (nxt == "\n" and src.pos - 1 in src.joins):
                    raise self.fail(unterminated)
                if nxt == delim:
                    out.append(delim)
                elif nxt == "\n":
                    out.append("\n")
                else:
                    out.append("\\" + nxt)
                continue
            if ch == "[":
                out.append(self.bracket(delim, unterminated))
                continue
            out.append(ch)

    def bracket(self, delim: str, unterminated: str) -> str:
        """A bracket expression, from after its ``[``: the delimiter is
        an ordinary character inside it.

        Args:
            delim (str): the delimiter.
            unterminated (str): the refusal when the text never ends.
        """
        src = self.src
        out = ["["]
        if src.peek() == "^":
            out.append(src.get() or "")
        if src.peek() == "]":
            out.append(src.get() or "")
        while True:
            ch = src.get()
            if ch is None or ch == "\n":
                raise self.fail(unterminated)
            if ch == "]":
                out.append(ch)
                return "".join(out)
            if ch == "[" and src.peek() in (":", ".", "="):
                kind = src.get() or ""
                out.append("[" + kind)
                while True:
                    inner = src.get()
                    if inner is None or inner == "\n":
                        raise self.fail(unterminated)
                    out.append(inner)
                    if inner == kind and src.peek() == "]":
                        out.append(src.get() or "")
                        break
                continue
            out.append(ch)

    def regex(self, raw: str, icase: bool, multiline: bool) -> SedRegex:
        if raw == "":
            if icase or multiline:
                raise self.fail("cannot specify modifiers on empty regexp")
            return SedRegex(None)
        try:
            text = self.view(_regex_text(raw))
        except _RecursiveEscape:
            raise self.fail(_RECURSIVE) from None
        try:
            compiled = PosixRegex(
                text, self.extended, "sed", icase, self.utf8, multiline
            )
        except RegexError as exc:
            if exc.message.startswith("character class syntax is"):
                raise SedError(
                    f"sed: {exc.message}", 4, self.program.wfiles
                ) from exc
            raise self.fail(exc.message) from exc
        return SedRegex(compiled)

    def end_of_command(self) -> None:
        src = self.src
        ch = src.skip(_BLANKS)
        if ch is None:
            return
        if ch in "\n;":
            src.get()
            return
        if ch in "}#":
            return
        src.get()
        raise self.fail("extra characters after command")

    def command(self) -> None:
        src = self.src
        cmd = SedCommand(name="")
        cmd.addr1 = self.address()
        if cmd.addr1 is not None:
            if src.skip(_BLANKS) == ",":
                src.get()
                cmd.addr2 = self.second_address()
        ch = src.skip(_BLANKS)
        bang: int | None = None
        if ch == "!":
            src.get()
            bang = src.pos
            cmd.negate = True
            ch = src.skip(_BLANKS)
            if ch == "!":
                src.get()
                raise self.fail("multiple `!'s")
        name = src.get()
        if name is None or name == "\n" or name == ";":
            raise self.fail("missing command")
        cmd.name = name
        self.check_addresses(cmd, bang)
        handler = _HANDLERS.get(name)
        if handler is None:
            if name == "e":
                raise self.fail("`e' command not supported")
            raise self.fail(f"unknown command: `{name}'")
        handler(self, cmd)

    def check_addresses(self, cmd: SedCommand, bang: int | None) -> None:
        """Refuse addresses the command cannot take, where GNU does: line
        0 at the ``!`` when there is one, the rest at the command.

        Args:
            cmd (SedCommand): the command, its letter read.
            bang (int | None): where a ``!`` ended.
        """
        first, second = cmd.addr1, cmd.addr2
        if first is not None and first.number == 0:
            zero_line = (
                first.kind is AddressKind.LINE
                and (second is None or second.kind is not AddressKind.REGEX)
                and not (cmd.name == "r" and second is None)
            )
            if zero_line:
                raise self.fail_at(bang, "invalid usage of line address 0")
        if cmd.name == ":" and first is not None:
            raise self.fail(": doesn't want any addresses")
        if cmd.name == "#" and first is not None:
            raise self.fail("comments don't accept any addresses")
        if cmd.name in "qQ" and second is not None:
            raise self.fail("command only uses one address")

    def add(self, cmd: SedCommand) -> None:
        self.program.commands.append(cmd)

    def label(self) -> str:
        src = self.src
        src.skip(_BLANKS)
        start = src.pos
        while (ch := src.peek()) is not None and ch not in _SPACES + ";}#":
            src.pos += 1
        return src.text[start : src.pos]

    def filename(self) -> str:
        src = self.src
        src.skip(_BLANKS)
        start = src.pos
        while (ch := src.peek()) is not None and ch != "\n":
            src.pos += 1
        name = src.text[start : src.pos]
        if not name:
            raise self.fail("missing filename in r/R/w/W commands")
        if src.peek() == "\n":
            src.get()
        # A name is shell text in either locale, which the files resolve.
        return decode_text(from_byte_view(name))

    def wfile(self, name: str) -> None:
        if name not in self.program.wfiles:
            self.program.wfiles.append(name)

    def text(self, name: str) -> str | None:
        """The text of ``a``, ``i`` or ``c``: GNU's one-line form after
        blanks, or after a backslash and a newline the lines that follow,
        each escaped newline continuing it. None when there is none at
        all.

        Args:
            name (str): the command, ``a``, ``i`` or ``c``.
        """
        src = self.src
        ch = src.skip(_BLANKS)
        if ch is None or ch == "\n":
            raise self.fail("expected \\ after `a', `c' or `i'")
        if ch == "\\":
            src.get()
            if src.peek() == "\n":
                src.get()
            elif src.peek() is None:
                return None
        out: list[str] = []
        read = recursive = False
        start = src.pos
        while (ch := src.get()) is not None:
            read = True
            if ch == "\n":
                break
            if ch != "\\":
                out.append(ch)
                continue
            nxt = src.peek()
            if nxt is None:
                # Text that runs to the end of the script on a backslash
                # goes out as written, that backslash dropped.
                return self.view(src.text[start : src.pos - 1]) + "\n"
            src.get()
            if nxt == "\n":
                out.append("\n")
                continue
            if nxt == "c" and src.peek() in (None, "\n"):
                # A `\c` that ends the text: `a` takes the closing newline
                # into it (^J), `i` and `c` drop it.
                if src.peek() == "\n":
                    src.get()
                if recursive:
                    raise self.fail(_RECURSIVE)
                if name == "a":
                    return self.view("".join(out) + "J")
                return self.view("".join(out)) + "\n"
            try:
                found = _escape(src.text, src.pos - 1)
            except _RecursiveEscape:
                # GNU refuses it once the text has been read.
                recursive = True
                continue
            if found is None:
                out.append(nxt)
                continue
            out.append(found[0])
            src.pos = found[1]
        if recursive:
            raise self.fail(_RECURSIVE)
        if not read:
            return None
        return self.view("".join(out)) + "\n"

    def replacement(self, raw: str, groups: int) -> list[ReplacementPart]:
        parts: list[ReplacementPart] = []
        literal: list[str] = []

        def flush() -> None:
            if literal:
                parts.append(ReplacementPart(text=self.view("".join(literal))))
                literal.clear()

        i = 0
        while i < len(raw):
            ch = raw[i]
            if ch == "&":
                flush()
                parts.append(ReplacementPart(group=0))
                i += 1
                continue
            if ch != "\\" or i + 1 >= len(raw):
                literal.append(ch)
                i += 1
                continue
            nxt = raw[i + 1]
            if _is_digit(nxt):
                group = int(nxt)
                if group > groups:
                    raise self.fail(
                        f"invalid reference \\{group} on `s' command's RHS"
                    )
                flush()
                parts.append(ReplacementPart(group=group))
                i += 2
                continue
            if nxt in _CASE:
                flush()
                parts.append(ReplacementPart(case=nxt))
                i += 2
                continue
            found = _escape(raw, i + 1)
            if found is None:
                literal.append(nxt)
                i += 2
                continue
            literal.append(found[0])
            i = found[1]
        flush()
        return parts

    def substitute(self, cmd: SedCommand) -> None:
        src = self.src
        delim = src.get()
        if delim is None or delim in "\n\\":
            raise self.fail("unterminated `s' command")
        self.delimiter(delim)
        raw = self.delimited(delim, "unterminated `s' command")
        rhs = self.rhs(delim)
        subst = SedSubstitution(SedRegex(None), [])
        icase = multiline = False
        seen_g = seen_p = seen_n = False
        while True:
            ch = src.get()
            if ch is None or ch in "\n;":
                break
            if ch in "}#":
                src.unget()
                break
            if ch == "\r" and src.peek() == "\n":
                # A script written with CRLF line ends.
                src.get()
                break
            if ch in _BLANKS:
                continue
            if ch == "g":
                if seen_g:
                    raise self.fail("multiple `g' options to `s' command")
                seen_g = subst.global_ = True
            elif ch == "p":
                if seen_p:
                    raise self.fail("multiple `p' options to `s' command")
                seen_p = subst.print_ = True
            elif _is_digit(ch):
                src.unget()
                if seen_n:
                    self.number()
                    raise self.fail("multiple number options to `s' command")
                seen_n = True
                subst.occurrence = self.number()
                if subst.occurrence == 0:
                    raise self.fail(
                        "number option to `s' command may not be zero"
                    )
            elif ch in "iI":
                icase = True
            elif ch in "mM":
                multiline = True
            elif ch == "e":
                raise self.fail("`e' command not supported")
            elif ch == "w":
                subst.wfile = self.filename()
                self.wfile(subst.wfile)
                break
            else:
                raise self.fail("unknown option to `s'")
        subst.regex = self.regex(raw, icase, multiline)
        groups = 9 if subst.regex.regex is None else subst.regex.regex.groups
        try:
            subst.parts = self.replacement(rhs, groups)
        except _RecursiveEscape:
            raise self.fail(_RECURSIVE) from None
        cmd.subst = subst
        self.add(cmd)

    def rhs(self, delim: str) -> str:
        """An ``s`` replacement up to its unescaped delimiter, escapes
        kept for ``replacement`` and a ``\\delim`` its literal character.

        Args:
            delim (str): the delimiter.
        """
        src = self.src
        out: list[str] = []
        while True:
            ch = src.get()
            if ch is None or ch == "\n":
                raise self.fail("unterminated `s' command")
            if ch == delim:
                return "".join(out)
            if ch == "\\":
                nxt = src.get()
                if nxt is None or (nxt == "\n" and src.pos - 1 in src.joins):
                    raise self.fail("unterminated `s' command")
                if nxt == delim:
                    out.append("\\" + delim if delim in "&\\" else delim)
                elif nxt == "\n":
                    out.append("\n")
                else:
                    out.append("\\" + nxt)
                continue
            out.append(ch)

    def transliterate(self, cmd: SedCommand) -> None:
        src = self.src
        delim = src.get()
        if delim is None or delim in "\n\\":
            raise self.fail("unterminated `y' command")
        self.delimiter(delim)
        source = self.y_string(delim)
        target = self.y_string(delim)
        left, right = self.view(source), self.view(target)
        if len(left) != len(right):
            raise self.fail("strings for `y' command are different lengths")
        table: dict[str, str] = {}
        for a, b in zip(left, right, strict=True):
            table.setdefault(a, b)
        cmd.translit = table
        self.end_of_command()
        self.add(cmd)

    def y_string(self, delim: str) -> str:
        """One ``y`` string: read up to its delimiter first, so no escape
        can take the delimiter, then decoded.

        Args:
            delim (str): the delimiter.
        """
        src = self.src
        raw: list[str] = []
        while True:
            ch = src.get()
            if ch is None or ch == "\n":
                raise self.fail("unterminated `y' command")
            if ch == delim:
                break
            if ch != "\\":
                raw.append(ch)
                continue
            nxt = src.get()
            if nxt is None or (nxt == "\n" and src.pos - 1 in src.joins):
                raise self.fail("unterminated `y' command")
            raw.append(nxt if nxt == delim else "\\" + nxt)
        try:
            return _y_text("".join(raw))
        except _RecursiveEscape:
            # GNU refuses it at the end of the string.
            raise self.fail(_RECURSIVE) from None


def _simple(compiler: _Compiler, cmd: SedCommand) -> None:
    compiler.end_of_command()
    compiler.add(cmd)


def _open_block(compiler: _Compiler, cmd: SedCommand) -> None:
    compiler.blocks.append(len(compiler.program.commands))
    compiler.add(cmd)


def _close_block(compiler: _Compiler, cmd: SedCommand) -> None:
    if not compiler.blocks:
        raise compiler.fail("unexpected `}'")
    if cmd.addr1 is not None:
        raise compiler.fail("`}' doesn't want any addresses")
    start = compiler.blocks.pop()
    compiler.program.commands[start].block_end = len(compiler.program.commands)
    compiler.end_of_command()
    compiler.add(cmd)


def _with_number(compiler: _Compiler, cmd: SedCommand) -> None:
    compiler.src.skip(_BLANKS)
    if _is_digit(compiler.src.peek()):
        # `l` and `q` keep their number's low 32 bits as a signed int.
        low = compiler.number() & 0xFFFFFFFF
        cmd.number = low - (1 << 32) if low >> 31 else low
    compiler.end_of_command()
    compiler.add(cmd)


def _text(compiler: _Compiler, cmd: SedCommand) -> None:
    cmd.text = compiler.text(cmd.name)
    compiler.add(cmd)


def _label(compiler: _Compiler, cmd: SedCommand) -> None:
    label = compiler.label()
    if not label:
        raise compiler.fail('":" lacks a label')
    cmd.label = label
    compiler.add(cmd)


def _branch(compiler: _Compiler, cmd: SedCommand) -> None:
    cmd.label = compiler.label()
    compiler.add(cmd)


def _read_file(compiler: _Compiler, cmd: SedCommand) -> None:
    cmd.filename = compiler.filename()
    names = (
        compiler.program.rfiles
        if cmd.name == "r"
        else compiler.program.reader_files
    )
    if cmd.filename not in names:
        names.append(cmd.filename)
    compiler.add(cmd)


def _write_file(compiler: _Compiler, cmd: SedCommand) -> None:
    cmd.filename = compiler.filename()
    compiler.wfile(cmd.filename)
    compiler.add(cmd)


def _version(compiler: _Compiler, cmd: SedCommand) -> None:
    src = compiler.src
    src.skip(_BLANKS)
    start = src.pos
    while (ch := src.peek()) is not None and ch not in _SPACES + ";}#":
        src.pos += 1
    wanted = src.text[start : src.pos]
    if wanted and strverscmp(wanted, SED_VERSION) > 0:
        raise compiler.fail("expected newer version of sed")
    compiler.end_of_command()


def _substitute(compiler: _Compiler, cmd: SedCommand) -> None:
    compiler.substitute(cmd)


def _transliterate(compiler: _Compiler, cmd: SedCommand) -> None:
    compiler.transliterate(cmd)


_Handler: TypeAlias = Callable[[_Compiler, SedCommand], None]

_HANDLERS: dict[str, _Handler] = {
    "{": _open_block,
    "}": _close_block,
    "=": _simple,
    "a": _text,
    "i": _text,
    "c": _text,
    "b": _branch,
    "t": _branch,
    "T": _branch,
    ":": _label,
    "d": _simple,
    "D": _simple,
    "F": _simple,
    "g": _simple,
    "G": _simple,
    "h": _simple,
    "H": _simple,
    "l": _with_number,
    # sed 4.9 still reads `L` as `l` reads, and refuses it where it runs.
    "L": _with_number,
    "n": _simple,
    "N": _simple,
    "p": _simple,
    "P": _simple,
    "q": _with_number,
    "Q": _with_number,
    "r": _read_file,
    "R": _read_file,
    "s": _substitute,
    "v": _version,
    "w": _write_file,
    "W": _write_file,
    "x": _simple,
    "y": _transliterate,
    "z": _simple,
}


def compile_script(
    pieces: Sequence[SedScriptPiece], extended: bool, utf8: bool = False
) -> SedProgram:
    """Compile a sed script as GNU sed 4.9 reads it.

    The pieces join with newlines, so one command may span them
    (``-e 'a\\' -e 'text'``), and each diagnostic names the piece it is
    in: ``-e expression #N, char C`` or ``file NAME line L``.

    Args:
        pieces (Sequence[SedScriptPiece]): the -e and -f pieces in order.
        extended (bool): -E: extended rather than basic expressions.
        utf8 (bool): a UTF-8 locale: the script and the input are
            characters rather than bytes.

    Raises:
        SedError: a script GNU refuses, in its wording.
    """
    return _Compiler(pieces, extended, utf8).compile()
