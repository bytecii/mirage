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


@pytest.mark.parametrize("value", ["", "bogus"])
def test_invalid_binary_mode(value):
    with pytest.raises(UsageError, match="unknown binary-files type"):
        parse_flags(FlagView({"binary_files": value}, spec=SPECS["grep"]),
                    False)
