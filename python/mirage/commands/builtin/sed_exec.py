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

import logging
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import TypeAlias

from mirage.commands.builtin.sed_script import (
    SED_STDERR,
    SED_STDOUT,
    AddressKind,
    ReplacementPart,
    SedAddress,
    SedCommand,
    SedProgram,
    SedRegex,
    SedSubstitution,
)
from mirage.errors.classify import classify, failure_text
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.types import DotWalkLoop
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource
from mirage.io.yield_budget import YieldBudget
from mirage.rs.regex import Groups, PosixRegex
from mirage.shell.bytes import byte_view, from_byte_view, text_view

logger = logging.getLogger(__name__)

SED_LINE_LENGTH = 70
# How many pieces of output a run holds before it hands them on.
_CHUNK = 1 << 12
_ESCAPES = {
    0x5C: "\\\\",
    0x07: "\\a",
    0x08: "\\b",
    0x0C: "\\f",
    0x0A: "\\n",
    0x0D: "\\r",
    0x09: "\\t",
    0x0B: "\\v",
}


@dataclass(frozen=True, slots=True)
class SedFileText:
    """An ``r`` or ``R`` file read whole, as a byte view."""

    text: str


@dataclass(frozen=True, slots=True)
class SedFileSource:
    """An ``r`` or ``R`` file read when the script gets to it."""

    open: Callable[[], AsyncIterator[bytes]]


@dataclass(frozen=True, slots=True)
class SedFileError:
    """An ``r`` or ``R`` file that opens and cannot be read: GNU reports
    ``message`` and exits 4 when it gets there."""

    message: str


SedFileContent: TypeAlias = SedFileText | SedFileSource | SedFileError | None


@dataclass(slots=True)
class SedInput:
    """One input: its name as ``F`` prints it (``-`` for stdin) and its
    bytes."""

    name: str
    source: ByteSource


@dataclass(slots=True)
class SedRunOptions:
    """How a script runs: -n, -s (which -i implies), -l, the ``r`` and
    ``R`` files and whether the text is UTF-8."""

    suppress: bool = False
    separate: bool = False
    line_length: int = SED_LINE_LENGTH
    files: Mapping[str, SedFileContent] = field(default_factory=dict)
    reader_files: Mapping[str, SedFileContent] = field(default_factory=dict)
    utf8: bool = False


@dataclass(slots=True)
class SedOutput:
    """One output sed writes, as byte views, and whether its last line
    went out without the newline the input lacked: anything written
    after it puts that newline first."""

    chunks: list[str] = field(default_factory=list)
    missing_newline: bool = False

    def write(self, text: str) -> None:
        if not text:
            return
        if self.missing_newline:
            self.chunks.append("\n")
            self.missing_newline = False
        self.chunks.append(text)

    def line(self, text: str, newline: bool) -> None:
        if self.missing_newline:
            self.chunks.append("\n")
            self.missing_newline = False
        self.chunks.append(text)
        if newline:
            self.chunks.append("\n")
        else:
            self.missing_newline = True


class _Panic(Exception):
    """sed stops: ``message`` goes to stderr and it exits ``code``."""

    def __init__(self, message: str, code: int) -> None:
        super().__init__(message)
        self.message = message
        self.code = code


# The failures of opening an input, which GNU reports and reads on past
# (exit 2); any other is a read error that stops it (exit 4).
_OPEN_ERRORS = (
    FileNotFoundError,
    PermissionError,
    NotADirectoryError,
    DotWalkLoop,
)


_Entry: TypeAlias = tuple[str, str]


def _opens_failed(exc: BaseException) -> bool:
    return isinstance(exc, _OPEN_ERRORS)


def _read_error(name: str, exc: BaseException) -> _Panic:
    return _Panic(f"sed: read error on {name}: {failure_text(exc)}\n", 4)


def read_failed(exc: BaseException) -> bool:
    """Whether a failure to read an ``r`` or ``R`` file is the file's
    own, which sed reports against it: an fs error, or any condition the
    error vocabulary names, EIO included."""
    return isinstance(exc, FS_ERRORS) or classify(exc) is not None


def unreadable_file(name: str, exc: BaseException) -> SedFileError | None:
    """What an ``r`` or ``R`` file read whole ahead of the run holds when
    the read fails: nothing when it does not open, as POSIX asks, and
    otherwise the read error GNU exits 4 on when the script gets to it.

    Args:
        name (str): the file, as the script names it.
        exc (BaseException): the failure.
    """
    if _opens_failed(exc):
        logger.debug("sed r file %s does not open: %s", name, exc)
        return None
    return SedFileError(_read_error(name, exc).message)


def _quit_code(number: int | None) -> int:
    """The status ``q`` and ``Q`` exit with: the low byte of their number,
    except that -1 (low 32 bits all ones) exits 0, as sed 4.9 does."""
    if number is None or number == -1:
        return 0
    return number & 0xFF


def _zero_line(cmd: SedCommand) -> bool:
    """Whether the command is addressed by line 0 alone (``0r``)."""
    first = cmd.addr1
    return (
        first is not None
        and cmd.addr2 is None
        and first.kind is AddressKind.LINE
        and first.number == 0
    )


def _cut_lines(text: str) -> list[str]:
    """``text`` cut after each newline, and only there."""
    lines = text.split("\n")
    out = [line + "\n" for line in lines[:-1]]
    if lines[-1]:
        out.append(lines[-1])
    return out


@dataclass(slots=True)
class _Line:
    text: str
    newline: bool
    source: int


class _Reader:
    """The lines of one byte source, read through one growing buffer: a
    line's pieces are searched once each and copied once, however many
    chunks it arrives in.

    Args:
        source (ByteSource): the bytes.
        utf8 (bool): a UTF-8 locale.
        budget (YieldBudget): the machine's budget, which each pull
            takes too, so a line that never ends still lets the loop run.
    """

    def __init__(
        self, source: ByteSource, utf8: bool, budget: YieldBudget
    ) -> None:
        self.chunks = ensure_stream(source)
        self.utf8 = utf8
        self.budget = budget
        self.buffer = bytearray()
        # Where the unread bytes start, and how far a newline was looked
        # for among them.
        self.start = 0
        self.scanned = 0
        self.ended = False
        self.started = False

    async def _pull(self) -> None:
        await self.budget.run()
        chunk = await anext(self.chunks, None)
        if chunk is None:
            self.ended = True
            return
        self.started = True
        if self.start > len(self.buffer) // 2:
            del self.buffer[: self.start]
            self.scanned -= self.start
            self.start = 0
        self.buffer += chunk

    async def peek(self) -> bool:
        """Whether another byte follows, pulling no more than it takes
        to see one."""
        while self.start >= len(self.buffer):
            if self.ended:
                return False
            await self._pull()
        return True

    def _newline(self) -> int:
        cut = self.buffer.find(b"\n", max(self.scanned, self.start))
        if cut < 0:
            self.scanned = len(self.buffer)
        return cut

    def has_line(self) -> bool:
        """Whether the next line is in hand without a pull."""
        return self.ended or self._newline() >= 0

    async def line(self) -> tuple[str, bool] | None:
        while True:
            cut = self._newline()
            if cut >= 0:
                raw = bytes(self.buffer[self.start : cut])
                self.start = self.scanned = cut + 1
                return byte_view(raw, self.utf8), True
            if self.ended:
                if self.start >= len(self.buffer):
                    return None
                raw = bytes(self.buffer[self.start :])
                self.start = self.scanned = len(self.buffer)
                return byte_view(raw, self.utf8), False
            await self._pull()


class _Feed:
    """The input lines, one input after another, with the one-byte
    look-ahead sed needs for ``$``, ``n`` and ``N``: an input that fails
    as it is looked into ends there without a word, where reading on
    reports it.

    Args:
        machine (SedMachine): whose diagnostics the feed records.
        inputs (Sequence[SedInput]): the inputs in order.
    """

    def __init__(self, machine: "SedMachine", inputs: Sequence[SedInput]):
        self.machine = machine
        self.inputs = list(inputs)
        self.index = -1
        self.reader: _Reader | None = None

    def name(self, index: int) -> str:
        return self.inputs[index].name

    def waits(self) -> bool:
        """Whether the next line takes a pull, which may wait on the
        input."""
        if self.reader is None:
            return self.index + 1 < len(self.inputs)
        return not self.reader.has_line()

    async def _next_of_reader(self) -> _Line | None:
        reader = self.reader
        assert reader is not None
        name = self.name(self.index)
        try:
            got = await reader.line()
        except FS_ERRORS as exc:
            self.reader = None
            if _opens_failed(exc) and not reader.started:
                self.machine.bad_input(name, exc)
                return None
            shown = "stdin" if name == "-" else name
            raise _Panic(
                f"sed: read error on {shown}: {fs_strerror(exc) or exc}\n", 4
            ) from exc
        if got is None:
            self.reader = None
            return None
        return _Line(got[0], got[1], self.index)

    def _advance(self) -> bool:
        if self.index + 1 >= len(self.inputs):
            return False
        self.index += 1
        self.reader = _Reader(
            self.inputs[self.index].source,
            self.machine.opts.utf8,
            self.machine.budget,
        )
        return True

    async def read(self) -> _Line | None:
        while True:
            if self.reader is not None:
                got = await self._next_of_reader()
                if got is not None:
                    return got
            if not self._advance():
                return None

    async def _peek(self) -> bool:
        reader = self.reader
        assert reader is not None
        try:
            if await reader.peek():
                return True
        except FS_ERRORS as exc:
            if _opens_failed(exc) and not reader.started:
                self.machine.bad_input(self.name(self.index), exc)
            else:
                logger.debug("sed look-ahead ends at a failed read: %s", exc)
        self.reader = None
        return False

    async def more(self, within: bool) -> bool:
        """Whether another line follows, in the current input only when
        ``within``.

        Args:
            within (bool): stop at the end of the current input.
        """
        while True:
            if self.reader is not None and await self._peek():
                return True
            if within or not self._advance():
                return False


def _ascii_case(text: str, upper: bool) -> str:
    if text.isascii():
        return text.upper() if upper else text.lower()
    return "".join(
        (ch.upper() if upper else ch.lower()) if ch.isascii() else ch
        for ch in text
    )


def _unicode_case(text: str, upper: bool) -> str:
    out = []
    for ch in text:
        other = ch.upper() if upper else ch.lower()
        out.append(other if len(other) == 1 else ch)
    return "".join(out)


class SedMachine:
    """Runs a compiled script over its inputs as GNU sed 4.9 does.

    The pattern and hold spaces, the append queue, the ranges and the
    ``w`` outputs live here; ``process`` reads the inputs and yields what
    the script prints, as byte views.

    Args:
        program (SedProgram): the compiled script.
        opts (SedRunOptions): how it runs.
    """

    def __init__(self, program: SedProgram, opts: SedRunOptions) -> None:
        self.program = program
        self.opts = opts
        self.quiet = opts.suppress or program.quiet
        self.wfiles: dict[str, SedOutput] = {
            name: SedOutput()
            for name in program.wfiles
            if name not in (SED_STDOUT, SED_STDERR)
        }
        self.stdout = SedOutput()
        self._stderr: list[str] = []
        self._error_out = SedOutput()
        self.panic_code: int | None = None
        self._bad = False
        self._quit: int | None = None
        self._last: PosixRegex | None = None
        self.hold = ""
        # Whether the hold space's text ended in a newline when read: it
        # travels with the text into the pattern space.
        self._hold_newline = True
        self.line = 0
        # Each open range and, for `addr,+N`, the line it ends on.
        self._ranges: dict[int, int] = {}
        # Line-number ranges that have started, which never start again.
        self._begun: set[int] = set()
        self._readers: dict[str, list[str] | _Reader | None] = {}
        # Readers a new input under -s left behind, closed with the rest.
        self._stale: list[_Reader] = []
        self._out = SedOutput()
        # The rest of each `r` file in `_out`: the piece it follows, its
        # name and its stream.
        self._tails: list[tuple[int, str, AsyncIterator[bytes]]] = []
        self.budget = YieldBudget()
        # Where the line `_cycle` hands back resumes: 0 for `D`, a branch's
        # target for a cycle that stopped to hand its output on.
        self._resume = 0
        # Whether that line resumes the `n` it stopped in after its print.
        self._reading = False
        # The commands that may look ahead or read: before one of them,
        # output waiting on the input goes out first.
        self._reads = [
            cmd.name in "nN"
            or any(
                addr is not None and addr.kind is AddressKind.LAST
                for addr in (cmd.addr1, cmd.addr2)
            )
            for cmd in program.commands
        ]
        self._queue: list[_Entry] = []
        self._replaced = False
        self._source = -1
        self._started = False
        self._inline = True
        self._stdout_alias = SedOutput(self._out.chunks)
        self._feed = _Feed(self, [])
        self._case = _unicode_case if opts.utf8 else _ascii_case

    def stopped(self) -> bool:
        return self._quit is not None or self.panic_code is not None

    def set_files(self, files: Mapping[str, SedFileContent]) -> None:
        self.opts.files = files

    def stderr(self) -> str:
        return "".join(self._stderr)

    def exit_code(self) -> int:
        if self.panic_code is not None:
            return self.panic_code
        if self._bad:
            return 2
        return self._quit or 0

    def bad_input(self, name: str, exc: BaseException) -> None:
        self._bad = True
        self._stderr.append(
            f"sed: can't read {name}: {fs_strerror(exc) or exc}\n"
        )

    def _output(self, name: str) -> SedOutput:
        if name == SED_STDOUT:
            return self._stdout_alias if self._inline else self.stdout
        if name == SED_STDERR:
            return self._error_out
        return self.wfiles[name]

    def _restart(self) -> None:
        """A new input under -s or -i: line numbers, the hold space,
        ranges and ``R`` readers start over."""
        self.line = 0
        self.hold = ""
        self._hold_newline = True
        self._ranges = {}
        self._begun = set()
        self._readers, stale = {}, self._readers
        self._stale.extend(
            reader for reader in stale.values() if isinstance(reader, _Reader)
        )
        self._open_ranges()

    def _open_ranges(self) -> None:
        for index, cmd in enumerate(self.program.commands):
            first = cmd.addr1
            if (
                first is not None
                and cmd.addr2 is not None
                and first.kind is AddressKind.LINE
                and first.number == 0
            ):
                self._ranges[index] = 0
                self._begun.add(index)

    async def _take(self, feed: _Feed) -> _Line | None:
        got = await feed.read()
        if got is None:
            return None
        if got.source != self._source:
            if self.opts.separate and self._source != -1:
                self._restart()
            self._source = got.source
        self.line += 1
        self._replaced = False
        return got

    async def process(
        self,
        inputs: Sequence[SedInput],
        inline: bool,
        flush: Callable[[], Awaitable[None]],
    ) -> AsyncGenerator[str, None]:
        """Run the script over ``inputs`` and yield what it prints.

        Args:
            inputs (Sequence[SedInput]): the inputs, in order.
            inline (bool): ``w /dev/stdout`` writes into what is yielded;
                otherwise it collects in ``stdout`` (-i).
            flush (Callable[[], Awaitable[None]]): drains the ``w``
                files, called after a cycle that wrote to one.
        """
        self._inline = inline
        self._out = SedOutput()
        # `w /dev/stdout` is its own stream into the same output, so a line
        # it writes without a newline does not hold back the next print.
        self._stdout_alias = SedOutput(self._out.chunks)
        self._source = -1
        if self.opts.separate or not self._started:
            self._restart()
        self._started = True
        feed = _Feed(self, inputs)
        self._feed = feed
        try:
            async with aclosing(self._run(feed, flush)) as chunks:
                async for chunk in chunks:
                    yield chunk
        finally:
            # Inputs a `q` or a failure left unread, the `r` files a reader
            # left before their end and the `R` readers close here rather
            # than when they are collected.
            for given in inputs:
                await close_quietly(given.source)
            tails, self._tails = self._tails, []
            for _, _, tail in tails:
                await close_quietly(tail)
            await self._close_readers()

    async def _close_readers(self) -> None:
        readers, self._readers = self._readers, {}
        stale, self._stale = self._stale, []
        for reader in [*stale, *readers.values()]:
            if isinstance(reader, _Reader):
                await close_quietly(reader.chunks)

    async def _run(
        self, feed: _Feed, flush: Callable[[], Awaitable[None]]
    ) -> AsyncGenerator[str, None]:
        try:
            line = await self._take(feed)
            pc = 0
            while line is not None and not self.stopped():
                again = await self._cycle(line, pc)
                pc = self._resume
                if any(out.chunks for out in self.wfiles.values()):
                    await flush()
                if self._error_out.chunks:
                    self._stderr.append(
                        text_view(
                            "".join(self._error_out.chunks), self.opts.utf8
                        )
                    )
                    self._error_out.chunks.clear()
                if self._full() or (self._pending() and feed.waits()):
                    async with aclosing(self._drain()) as pieces:
                        async for piece in pieces:
                            yield piece
                if again is not None:
                    line = again
                    continue
                if self.stopped():
                    break
                line = await self._take(feed)
        except _Panic as exc:
            self._stderr.append(exc.message)
            self.panic_code = exc.code
        if self._error_out.chunks:
            self._stderr.append(
                text_view("".join(self._error_out.chunks), self.opts.utf8)
            )
            self._error_out.chunks.clear()
        async with aclosing(self._drain()) as pieces:
            async for piece in pieces:
                yield piece

    def _full(self) -> bool:
        """Whether what a loop has printed, to the output or to a ``w``
        file, should go out before it runs on."""
        return (
            bool(self._tails)
            or len(self._out.chunks) >= _CHUNK
            or any(len(out.chunks) >= _CHUNK for out in self.wfiles.values())
        )

    def _pending(self) -> bool:
        return bool(self._tails or self._out.chunks)

    def _held(self) -> bool:
        """Whether output would wait behind a read that may wait."""
        return self._pending() and self._feed.waits()

    async def _drain(self) -> AsyncGenerator[str, None]:
        """Hand on what the run has printed, each ``r`` file streamed
        where it goes out."""
        chunks = self._out.chunks
        tails = self._tails
        at = 0
        for index, (cut, name, tail) in enumerate(tails):
            # The files not streamed yet stay where an early close of the
            # run finds them.
            self._tails = tails[index:]
            if cut > at:
                yield "".join(chunks[at:cut])
            at = cut
            try:
                async for chunk in tail:
                    if chunk:
                        yield byte_view(chunk, self.opts.utf8)
            except FS_ERRORS as exc:
                # GNU stops where the file fails: what was printed after
                # it never goes out.
                failed = _read_error(name, exc)
                self._stderr.append(failed.message)
                self.panic_code = failed.code
                for _, _, later in tails[index + 1 :]:
                    await close_quietly(later)
                self._tails = []
                chunks.clear()
                return
            finally:
                await close_quietly(tail)
        self._tails = []
        rest = "".join(chunks[at:])
        chunks.clear()
        if rest:
            yield rest

    async def _is_last(self) -> bool:
        return not await self._feed.more(self.opts.separate)

    async def _more(self) -> bool:
        """Whether ``n`` or ``N`` has a line to read: under -s only in
        the input they are in, whose end is then theirs as the last
        input's would be, and sed goes on with the next."""
        return await self._feed.more(self.opts.separate)

    def _regex(self, sed_regex: SedRegex) -> PosixRegex:
        regex = sed_regex.regex
        if regex is None:
            if self._last is None:
                raise _Panic(
                    "sed: -e expression #1, char 0: "
                    "no previous regular expression\n",
                    1,
                )
            return self._last
        self._last = regex
        return regex

    def _matches(self, sed_regex: SedRegex, text: str) -> bool:
        return self._regex(sed_regex).matches(text)

    async def _match(self, addr: SedAddress, ps: str) -> bool:
        kind = addr.kind
        if kind is AddressKind.LINE:
            # `0r` is the one command line 0 addresses: it runs on the
            # first line, where the script reaches it.
            return self.line == max(addr.number, 1)
        if kind is AddressKind.LAST:
            return await self._is_last()
        if kind is AddressKind.REGEX:
            assert addr.regex is not None
            return self._matches(addr.regex, ps)
        if kind is AddressKind.STEP:
            if addr.step <= 0:
                return self.line == addr.number
            return (
                self.line >= addr.number
                and (self.line - addr.number) % addr.step == 0
            )
        return False

    async def _in_range(self, index: int, cmd: SedCommand, ps: str) -> bool:
        first, second = cmd.addr1, cmd.addr2
        assert first is not None and second is not None
        end = self._ranges.get(index)
        if end is not None:
            kind = second.kind
            if kind is AddressKind.LINE:
                if self.line >= second.number:
                    del self._ranges[index]
                    return self.line == second.number
                return True
            if kind is AddressKind.PLUS:
                if self.line >= end:
                    del self._ranges[index]
                return True
            if kind is AddressKind.MULTIPLE:
                if second.number <= 0 or self.line % second.number == 0:
                    del self._ranges[index]
                return True
            if kind is AddressKind.STEP:
                if await self._match(second, ps):
                    del self._ranges[index]
                return True
            if kind is AddressKind.LAST:
                if await self._is_last():
                    del self._ranges[index]
                return True
            assert second.regex is not None
            if self._matches(second.regex, ps):
                del self._ranges[index]
            return True
        if first.kind is AddressKind.LINE:
            # A range from a line number starts on the first line at or
            # past it, so one an `n` read over still opens, unless its
            # numbered end has gone by; it starts only once.
            if index in self._begun or self.line < first.number:
                return False
            if (
                self.line > first.number
                and second.kind is AddressKind.LINE
                and self.line > second.number
            ):
                return False
            self._begun.add(index)
        elif not await self._match(first, ps):
            return False
        kind = second.kind
        if kind is AddressKind.LINE:
            if second.number > self.line:
                self._ranges[index] = 0
        elif kind is AddressKind.PLUS:
            if second.number > 0:
                # Counted in 64 bits, as sed counts, so the end can wrap.
                self._ranges[index] = (self.line + second.number) % (1 << 64)
        elif kind is AddressKind.MULTIPLE:
            if second.number > 0:
                self._ranges[index] = 0
        elif kind is AddressKind.STEP:
            # Unlike `addr1,~N`, a `first~step` end can be the line that
            # opens the range.
            if not await self._match(second, ps):
                self._ranges[index] = 0
        elif kind is AddressKind.LAST:
            if not await self._is_last():
                self._ranges[index] = 0
        else:
            self._ranges[index] = 0
        return True

    async def _applies(self, index: int, cmd: SedCommand, ps: str) -> bool:
        if cmd.addr1 is None:
            return not cmd.negate
        if cmd.addr2 is None:
            hit = await self._match(cmd.addr1, ps)
        else:
            hit = await self._in_range(index, cmd, ps)
        return hit != cmd.negate

    async def _emit_file(self, name: str) -> None:
        content = self.opts.files.get(name)
        if content is None:
            return
        if isinstance(content, SedFileError):
            raise _Panic(content.message, 4)
        if isinstance(content, SedFileText):
            self._out.write(content.text)
            return
        # The first piece is read here, where a directory fails as GNU
        # reports it; the rest streams out when the output gets to it.
        stream = content.open()
        first = b""
        try:
            while not first:
                got = await anext(stream, None)
                if got is None:
                    return
                first = got
        except Exception as exc:
            if not read_failed(exc):
                raise
            await close_quietly(stream)
            if not _opens_failed(exc):
                raise _read_error(name, exc) from exc
            # A file that cannot be opened reads as empty, as POSIX asks.
            logger.debug("sed r file %s does not open: %s", name, exc)
            return
        self._out.write(byte_view(first, self.opts.utf8))
        self._tails.append((len(self._out.chunks), name, stream))

    async def _reader_line(self, name: str) -> str | None:
        """The next line of an ``R`` file, its newline kept."""
        if name not in self._readers:
            content = self.opts.reader_files.get(name)
            if isinstance(content, SedFileError):
                raise _Panic(content.message, 4)
            if isinstance(content, SedFileText):
                self._readers[name] = _cut_lines(content.text)[::-1]
            elif isinstance(content, SedFileSource):
                self._readers[name] = _Reader(
                    content.open(), self.opts.utf8, self.budget
                )
            else:
                self._readers[name] = None
        reader = self._readers[name]
        if reader is None:
            return None
        if isinstance(reader, list):
            return reader.pop() if reader else None
        try:
            got = await reader.line()
        except Exception as exc:
            if not read_failed(exc):
                raise
            self._readers[name] = None
            await close_quietly(reader.chunks)
            if not _opens_failed(exc) or reader.started:
                raise _read_error(name, exc) from exc
            # A file that cannot be opened reads as empty, as POSIX asks.
            logger.debug("sed R file %s does not open: %s", name, exc)
            return None
        if got is None:
            return None
        return got[0] + ("\n" if got[1] else "")

    async def _dump(self) -> None:
        queue, self._queue = self._queue, []
        for kind, value in queue:
            if kind == "file":
                await self._emit_file(value)
            else:
                self._out.write(value)

    def _list(self, ps: str, width: int) -> str:
        pieces: list[str] = []
        for byte in from_byte_view(ps, self.opts.utf8):
            if byte in _ESCAPES:
                pieces.append(_ESCAPES[byte])
            elif 0x20 <= byte < 0x7F:
                pieces.append(chr(byte))
            else:
                pieces.append(f"\\{byte:03o}")
        out: list[str] = []
        used = 0
        limit = width - 1
        for piece in pieces:
            if width > 0 and used + len(piece) > limit:
                out.append("\\\n")
                used = 0
            out.append(piece)
            used += len(piece)
        out.append("$\n")
        return "".join(out)

    def _expand(
        self, parts: list[ReplacementPart], ps: str, groups: Groups
    ) -> str:
        out: list[str] = []
        mode: str | None = None
        pending: str | None = None
        passed = 0
        case = self._case
        for part in parts:
            if part.case is not None:
                if part.case in "ul":
                    pending, passed = part.case, 0
                else:
                    pending = None
                    mode = None if part.case == "E" else part.case
                continue
            if part.group is not None:
                span = groups[part.group] if part.group < len(groups) else None
                text = "" if span is None else ps[span[0] : span[1]]
            else:
                text = part.text
            if mode is not None:
                text = case(text, mode == "U")
            if pending is not None:
                if text:
                    text = case(text[0], pending == "u") + text[1:]
                    pending = None
                else:
                    passed += 1
                    if passed > 1:
                        pending = None
            out.append(text)
        return "".join(out)

    def _substitute(self, sub: SedSubstitution, ps: str) -> str | None:
        regex = self._regex(sub.regex)
        if sub.regex.regex is None:
            # An empty expression's groups are known only now.
            wanted = max((part.group or 0 for part in sub.parts), default=0)
            if wanted > regex.groups:
                raise _Panic(
                    "sed: -e expression #1, char 0: invalid reference "
                    f"\\{wanted} on `s' command's RHS\n",
                    1,
                )
        if sub.global_ or sub.occurrence > 1:
            found = regex.all(ps)
        else:
            one = regex.search(ps)
            found = [] if one is None else [one]
        chosen = (
            found[sub.occurrence - 1 :]
            if sub.global_
            else found[sub.occurrence - 1 : sub.occurrence]
        )
        if not chosen:
            return None
        out: list[str] = []
        at = 0
        for groups in chosen:
            whole = groups[0]
            assert whole is not None
            out.append(ps[at : whole[0]])
            out.append(self._expand(sub.parts, ps, groups))
            at = whole[1]
        out.append(ps[at:])
        return "".join(out)

    async def _cycle(self, line: _Line, pc: int) -> _Line | None:
        """One cycle over ``line`` from command ``pc``; the line to run
        again without reading, from ``_resume``, or None.

        A loop that prints stops at its branch once the output fills, and
        a command that may wait on the input stops before it while output
        is held, so what was printed goes out first.

        Args:
            line (_Line): the pattern space.
            pc (int): the command to start at.
        """
        # A script that loops without reading still lets the loop run.
        await self.budget.run()
        self._resume = 0
        reading, self._reading = self._reading, False
        ps = line.text
        newline = line.newline
        commands = self.program.commands
        count = len(commands)
        printing = not self.quiet
        while pc < count:
            cmd = commands[pc]
            if reading:
                # The `n` this cycle stopped in, its address taken.
                pass
            elif self._reads[pc] and self._held():
                self._resume = pc
                return _Line(ps, newline, line.source)
            elif not await self._applies(pc, cmd, ps):
                pc = cmd.block_end + 1 if cmd.name == "{" else pc + 1
                continue
            name = cmd.name
            pc += 1
            if name in "{}:":
                continue
            if name == "p":
                self._out.line(ps, newline)
            elif name == "s":
                assert cmd.subst is not None
                result = self._substitute(cmd.subst, ps)
                if result is not None:
                    ps = result
                    self._replaced = True
                    if cmd.subst.print_:
                        self._out.line(ps, newline)
                    if cmd.subst.wfile is not None:
                        self._output(cmd.subst.wfile).line(ps, newline)
            elif name == "d":
                await self._dump()
                return None
            elif name == "D":
                cut = ps.find("\n")
                if cut < 0:
                    await self._dump()
                    return None
                # The cycle restarts without reading, and the appends wait
                # for the line it ends on.
                return _Line(ps[cut + 1 :], newline, line.source)
            elif name in "bt":
                if name == "b" or self._replaced:
                    if name == "t":
                        self._replaced = False
                    assert cmd.target is not None
                    pc = cmd.target
                    if self._full():
                        self._resume = pc
                        return _Line(ps, newline, line.source)
                    await self.budget.run()
            elif name == "T":
                if not self._replaced:
                    assert cmd.target is not None
                    pc = cmd.target
                    if self._full():
                        self._resume = pc
                        return _Line(ps, newline, line.source)
                    await self.budget.run()
                else:
                    self._replaced = False
            elif name == "n":
                # GNU prints and appends whether or not a line follows.
                if not reading:
                    if printing:
                        self._out.line(ps, newline)
                    await self._dump()
                    if self._held():
                        self._resume, self._reading = pc - 1, True
                        return _Line(ps, newline, line.source)
                reading = False
                if not await self._more():
                    return None
                got = await self._take(self._feed)
                if got is None:
                    return None
                ps, newline = got.text, got.newline
            elif name == "N":
                if not await self._more():
                    break
                await self._dump()
                got = await self._take(self._feed)
                if got is None:
                    break
                ps = ps + "\n" + got.text
                newline = got.newline
            elif name == "a":
                if cmd.text is not None:
                    self._queue.append(("text", cmd.text))
            elif name == "i":
                if cmd.text is not None:
                    self._out.write(cmd.text)
            elif name == "c":
                ranged = cmd.addr2 is not None and not cmd.negate
                if (not ranged or pc - 1 not in self._ranges) and (
                    cmd.text is not None
                ):
                    self._out.write(cmd.text)
                await self._dump()
                return None
            elif name == "=":
                self._out.write(f"{self.line}\n")
            elif name == "L":
                raise _Panic("sed: INTERNAL ERROR: Bad cmd L\n", 4)
            elif name == "l":
                width = (
                    cmd.number
                    if cmd.number is not None
                    else self.opts.line_length
                )
                self._out.write(self._list(ps, width))
            elif name == "q":
                # `q` ends what it prints with a newline the input lacked.
                if printing:
                    self._out.line(ps, True)
                await self._dump()
                self._quit = _quit_code(cmd.number)
                return None
            elif name == "Q":
                self._queue = []
                self._quit = _quit_code(cmd.number)
                return None
            elif name == "r":
                if cmd.filename is None:
                    pass
                elif _zero_line(cmd):
                    # `0r` writes its file where it runs, ahead of the line.
                    await self._emit_file(cmd.filename)
                else:
                    self._queue.append(("file", cmd.filename))
            elif name == "R":
                if cmd.filename is not None:
                    got_line = await self._reader_line(cmd.filename)
                    if got_line is not None:
                        self._queue.append(("text", got_line))
            elif name == "w":
                assert cmd.filename is not None
                self._output(cmd.filename).line(ps, newline)
            elif name == "W":
                assert cmd.filename is not None
                cut = ps.find("\n")
                if cut < 0:
                    self._output(cmd.filename).line(ps, newline)
                else:
                    self._output(cmd.filename).line(ps[:cut], True)
            elif name == "P":
                cut = ps.find("\n")
                if cut < 0:
                    self._out.line(ps, newline)
                else:
                    self._out.line(ps[:cut], True)
            elif name == "h":
                self.hold, self._hold_newline = ps, newline
            elif name == "H":
                self.hold = self.hold + "\n" + ps
                self._hold_newline = newline
            elif name == "g":
                ps, newline = self.hold, self._hold_newline
            elif name == "G":
                ps = ps + "\n" + self.hold
                newline = self._hold_newline
            elif name == "x":
                ps, self.hold = self.hold, ps
                newline, self._hold_newline = self._hold_newline, newline
            elif name == "y":
                assert cmd.translit is not None
                table = cmd.translit
                ps = "".join(table.get(ch, ch) for ch in ps)
            elif name == "z":
                ps = ""
            elif name == "F":
                # The input opened last, which a look-ahead may have moved
                # past the line's own.
                name = self._feed.name(self._feed.index)
                self._out.write(byte_view(name, self.opts.utf8) + "\n")
        if printing:
            self._out.line(ps, newline)
        await self._dump()
        return None
