import re
from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.generic.grep import parse_flags
from mirage.commands.builtin.grep_binary import grep_input
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import IOResult, materialize


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk_size", [1, 2, 7, 1024, 32768])
@pytest.mark.parametrize("mode,stdout,stderr,code", [
    ("binary", b"", b"grep: /remote/data.pdf: binary file matches\n", 0),
    ("without-match", b"", b"", 1),
    ("text", b"2:needle\0tail\n", b"", 0),
])
async def test_binary_result_is_independent_of_backend_chunks(
        chunk_size, mode, stdout, stderr, code):
    data = b"before\nneedle\0tail\n"

    async def source() -> AsyncIterator[bytes]:
        for offset in range(0, len(data), chunk_size):
            yield data[offset:offset + chunk_size]

    flags = parse_flags(
        FlagView({
            "binary_files": mode,
            "n": True
        }, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(source(), re.compile("needle"), flags, "/remote/data.pdf",
                   False, io))
    assert (out, io.stderr or b"", io.exit_code) == (stdout, stderr, code)


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk_size", [1, 2, 3, 7, 32768])
async def test_multibyte_text_survives_split_reads(chunk_size):
    data = "é needle 😀\n".encode()

    async def source() -> AsyncIterator[bytes]:
        for offset in range(0, len(data), chunk_size):
            yield data[offset:offset + chunk_size]

    flags = parse_flags(FlagView({}, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    assert await materialize(
        grep_input(source(), re.compile("needle"), flags, "/doc.gdoc.json",
                   False, io)) == data
    assert io.exit_code == 0
    assert not io.stderr


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{"args_I": True}, {"q": True}, {}])
async def test_binary_scan_stops_after_bounded_probe(flags):
    block = b"needle\0" + b"x" * (32768 - 7)

    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            yield block
            raise AssertionError("unnecessary remote read")
        finally:
            closed = True

    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    assert await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/large.pdf",
                   False, io)) == b""
    assert closed


@pytest.mark.asyncio
async def test_max_count_does_not_prefetch_remote_rows():
    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            yield b"needle\n"
            raise AssertionError("read past the requested match")
        finally:
            closed = True

    f = parse_flags(FlagView({"m": 1}, spec=SPECS["grep"]), False)
    io = IOResult()
    assert await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/rows.jsonl",
                   False, io)) == b"needle\n"
    assert io.exit_code == 0
    assert closed


@pytest.mark.parametrize("flags, shown", [
    ({
        "B": "-1"
    }, "-1"),
    ({
        "A": "-1"
    }, "-1"),
    ({
        "C": "-1"
    }, "-1"),
    ({
        "A": "x"
    }, "x"),
    ({
        "B": "1.5"
    }, "1.5"),
    ({
        "B": -1
    }, "-1"),
    ({
        "B": "-1",
        "A": "x"
    }, "-1"),
    ({
        "A": "x",
        "B": "-1"
    }, "x"),
])
def test_invalid_context_length(flags, shown):
    with pytest.raises(
            UsageError,
            match=f"grep: {shown}: invalid context length argument"):
        parse_flags(FlagView(flags, spec=SPECS["grep"]), False)


@pytest.mark.parametrize("flags", [{"B": "-0"}, {"A": "0"}, {"C": 2}])
def test_valid_context_length(flags):
    parse_flags(FlagView(flags, spec=SPECS["grep"]), False)


@pytest.mark.parametrize("value", ["", "bogus"])
def test_invalid_binary_mode(value):
    with pytest.raises(UsageError, match="unknown binary-files type"):
        parse_flags(FlagView({"binary_files": value}, spec=SPECS["grep"]),
                    False)


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk_size", [1024, 32768, 65536])
@pytest.mark.parametrize("line_end", [b"", b"\n"])
@pytest.mark.parametrize("count_only", [False, True])
@pytest.mark.parametrize("binary_flag", [{
    "args_I": True
}, {
    "binary_files": "without-match"
}])
async def test_late_nul_discards_earlier_matches(chunk_size, line_end,
                                                 count_only, binary_flag):
    data = (b"needle\n" + b"x" * (32761 - len(line_end)) + line_end +
            b"\0tail\n")
    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            for offset in range(0, len(data), chunk_size):
                yield data[offset:offset + chunk_size]
            raise AssertionError("read past the binary block")
        finally:
            closed = True

    f = parse_flags(
        FlagView({
            **binary_flag, "c": count_only
        }, spec=SPECS["grep"]), False)
    io = IOResult()
    out = await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/late.txt", True,
                   io))
    # Streaming output already emitted before the NUL cannot be retracted.
    expected = (b"/remote/late.txt:0\n"
                if count_only else b"/remote/late.txt:needle\n")
    assert (out, io.stderr or b"", io.exit_code) == (expected, b"", 1)
    assert closed


@pytest.mark.asyncio
@pytest.mark.parametrize("flags,expected", [
    ({
        "m": 1,
        "c": True
    }, b"1\n"),
    ({
        "q": True
    }, b""),
    ({
        "args_l": True
    }, b"/remote/rows.jsonl\n"),
])
async def test_without_match_early_stop_does_not_read_ahead(flags, expected):
    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            yield b"needle\n"
            raise AssertionError("read past the requested match")
        finally:
            closed = True

    f = parse_flags(FlagView({
        "args_I": True,
        **flags
    }, spec=SPECS["grep"]), False)
    io = IOResult()
    out = await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/rows.jsonl",
                   False, io))
    assert (out, io.stderr or b"", io.exit_code) == (expected, b"", 0)
    assert closed


async def _lines(*rows: bytes):
    for row in rows:
        yield row


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, after_output, expected", [
    ({
        "A": 1
    }, True, b"--\nf:a\nf-b\n"),
    ({
        "A": 1
    }, False, b"f:a\nf-b\n"),
    ({
        "B": 1
    }, True, b"--\nf:a\n"),
    ({
        "c": True,
        "A": 1
    }, True, b"f:1\n"),
    ({
        "o": True,
        "A": 1
    }, True, b"f:a\n"),
    ({}, True, b"f:a\n"),
])
async def test_context_group_after_an_earlier_input_opens_with_separator(
        flags, after_output, expected):
    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult()
    out = await materialize(
        grep_input(_lines(b"a\nb\n"), re.compile("a"), f, "f", True, io,
                   after_output))
    assert out == expected
