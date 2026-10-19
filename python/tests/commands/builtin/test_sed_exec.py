import errno
from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.sed_exec import (
    SedFileContent,
    SedFileError,
    SedFileSource,
    SedFileText,
    SedInput,
    SedMachine,
    SedRunOptions,
    unreadable_file,
)
from mirage.commands.builtin.sed_script import SedScriptPiece, compile_script


async def _flush() -> None:
    pass


async def _pieces(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


async def _failing_after(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk
    raise PermissionError(13, "Permission denied", "/in")


async def _directory() -> AsyncIterator[bytes]:
    raise IsADirectoryError("/in1")
    yield b""


async def _missing() -> AsyncIterator[bytes]:
    raise FileNotFoundError(2, "No such file or directory", "/in0")
    yield b""


async def _run(
    script: str,
    *inputs: bytes | AsyncIterator[bytes],
    suppress: bool = False,
    separate: bool = False,
    files: dict[str, SedFileContent] | None = None,
) -> tuple[str, str, int, SedMachine]:
    program = compile_script([SedScriptPiece("expr", script)], False)
    machine = SedMachine(
        program,
        SedRunOptions(
            suppress=suppress,
            separate=separate,
            files=files or {},
            reader_files=files or {},
        ),
    )

    out = []
    sources = [SedInput(f"/in{i}", source) for i, source in enumerate(inputs)]
    async for chunk in machine.process(sources, True, _flush):
        out.append(chunk)
    return "".join(out), machine.stderr(), machine.exit_code(), machine


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "script,data,want",
    [
        (":a;N;$!ba;s/\\n/,/g", b"a\nb\nc\n", "a,b,c\n"),
        ("$!N;P;D", b"a\nb\nc\n", "a\nb\nc\n"),
        ("s/x*/-/g", b"abxd\n", "-a-b-d-\n"),
        ("s/b*/X/2", b"abbb\n", "aX\n"),
        ("2,4cMID", b"1\n2\n3\n4\n5\n", "1\nMID\n5\n"),
        ("s/\\w\\+/\\u&/g", b"hello world\n", "Hello World\n"),
        ("s/.*/\\u\\L&/", b"hELLO\n", "hello\n"),
        ("s/.*/\\L\\u&/", b"hello\n", "Hello\n"),
        ("s/\\(x*\\)\\(a\\)/\\u\\1\\2/", b"ab\n", "Ab\n"),
        ("s/\\(x*\\)\\(y*\\)\\(a\\)/\\u\\1\\2\\3/", b"ab\n", "ab\n"),
        ("s/x/[\\x26\\x5c1]/", b"x\n", "[&\\1]\n"),
        ("s/a\\x2eb/X/g", b"a.b axb\n", "X X\n"),
        ("y/el/ip/", b"hello\n", "hippo\n"),
        ("n;a X", b"a\nb\nc\n", "a\nb\nX\nc\n"),
        ("$G", b"a\nb", "a\nb\n\n"),
        ("p;q", b"abc", "abc\nabc\n"),
    ],
)
async def test_scripts_print_what_gnu_prints(script, data, want):
    out, err, code, _ = await _run(script, data)
    assert (out, err, code) == (want, "", 0)


@pytest.mark.asyncio
async def test_a_missing_newline_holds_until_more_follows():
    assert (await _run("p", b"a"))[0] == "a\na"
    assert (await _run("p;=", b"a\nb", suppress=True))[0] == "a\n1\nb\n2\n"
    assert (await _run("w /dev/stdout", b"a\nb"))[0] == "a\na\nbb"


@pytest.mark.asyncio
async def test_list_wraps_without_splitting_an_escape():
    out = (await _run("l 5", b"aaa\tb\n", suppress=True))[0]
    assert out == "aaa\\\n\\tb$\n"
    out = (await _run("l 1", b"abc\n", suppress=True))[0]
    assert out == "\\\na\\\nb\\\nc$\n"


@pytest.mark.asyncio
async def test_a_line_number_range_opens_late_once():
    data = b"".join(f"{n}\n".encode() for n in range(1, 7))
    assert (await _run("1{n;b};2,3p", data, suppress=True))[0] == "3\n"
    assert (await _run("1{n;n;b};2,3p", data, suppress=True))[0] == ""
    assert (await _run("2,/4/p", data, suppress=True))[0] == "2\n3\n4\n"
    assert (await _run("2,~4p", data, suppress=True))[0] == "2\n3\n4\n"
    assert (await _run("4,~4p", data, suppress=True))[0] == "4\n5\n6\n"


@pytest.mark.asyncio
async def test_separate_inputs_restart_lines_hold_and_ranges():
    out = (await _run("x", b"a\n", b"b\n", separate=True))[0]
    assert out == "\n\n"
    out = (await _run("$p", b"a\nb\n", b"c\n", suppress=True, separate=True))[
        0
    ]
    assert out == "b\nc\n"
    out = (await _run("N", b"a\nb\nc\n", b"d\n", separate=True))[0]
    assert out == "a\nb\nc\nd\n"


@pytest.mark.asyncio
async def test_the_look_ahead_passes_over_a_directory():
    out, err, code, _ = await _run(
        "$p", b"one\ntwo\n", _directory(), b"L1\n", suppress=True
    )
    assert (out, err, code) == ("L1\n", "", 0)
    out, err, code, _ = await _run(
        "p", b"one\n", _directory(), b"L1\n", suppress=True
    )
    assert out == "one\n"
    assert err == "sed: read error on /in1: Is a directory\n"
    assert code == 4


@pytest.mark.asyncio
async def test_a_line_reads_whole_across_chunks():
    one_byte_each = [bytes([byte]) for byte in b"x" * 2000]
    chunks = _pieces(b"ab", b"c\nd", b"", b"e", b"f\n", *one_byte_each, b"\n")
    out = (await _run("", chunks))[0]
    assert out == "abc\ndef\n" + "x" * 2000 + "\n"


class _Flushed(Exception):
    pass


async def _stop() -> None:
    raise _Flushed


@pytest.mark.asyncio
async def test_a_loop_hands_its_w_file_on_as_it_runs():
    program = compile_script([SedScriptPiece("expr", ":a\nw /f\nba")], False)
    machine = SedMachine(program, SedRunOptions(suppress=True))
    with pytest.raises(_Flushed):
        async for _ in machine.process([SedInput("-", b"x\n")], True, _stop):
            pass


@pytest.mark.asyncio
async def test_the_look_ahead_takes_one_byte():
    out, err, code, _ = await _run(
        "$!p;q", _failing_after(b"one\nx"), suppress=True
    )
    assert (out, err, code) == ("one\n", "", 0)


@pytest.mark.asyncio
async def test_a_read_failing_as_it_is_looked_into_ends_the_input():
    out, err, code, _ = await _run(
        "$p", _failing_after(b"first\n"), suppress=True
    )
    assert (out, err, code) == ("first\n", "", 0)
    out, err, code, _ = await _run(
        "p", _failing_after(b"first\n"), b"good\n", suppress=True
    )
    assert (out, err, code) == (
        "first\n",
        "sed: read error on /in0: Permission denied\n",
        4,
    )


@pytest.mark.asyncio
async def test_a_missing_input_is_reported_and_read_past():
    out, err, code, _ = await _run("q5", _missing(), b"one\n")
    assert out == "one\n"
    assert err == "sed: can't read /in0: No such file or directory\n"
    assert code == 2


@pytest.mark.asyncio
async def test_the_append_queue_and_files():
    files = {"/r": SedFileText("R1\n")}
    out = (await _run("1r /r\n1a X\n2r/r", b"a\nb\nc\n", files=files))[0]
    assert out == "a\nR1\nX\nb\nR1\nc\n"
    assert (await _run("0r /r", b"a\n", files=files))[0] == "R1\na\n"
    assert (await _run("1r /r\n1Q", b"a\n", files=files))[0] == ""


@pytest.mark.asyncio
async def test_r_files_stream_and_report_a_failed_read():
    files: dict[str, SedFileContent] = {
        "/r": SedFileSource(lambda: _failing_after(b"R1\n", b"R2"))
    }
    out, err, code, _ = await _run("1r /r\n$a X", b"a\nb\n", files=files)
    assert (out, err, code) == (
        "a\nR1\nR2",
        "sed: read error on /r: Permission denied\n",
        4,
    )


@pytest.mark.asyncio
async def test_R_cuts_its_file_at_newlines_only():
    files: dict[str, SedFileContent] = {
        "/r": SedFileText("left\rright\nnext\n")
    }
    out = (await _run("R /r", b"1\n2\n", files=files))[0]
    assert out == "1\nleft\rright\n2\nnext\n"


@pytest.mark.asyncio
async def test_D_keeps_the_append_queue_when_it_restarts():
    out = (await _run("$!N;a X\nP;D", b"a\nb\n"))[0]
    assert out == "a\nb\nX\nX\n"


@pytest.mark.asyncio
async def test_0r_runs_where_the_script_reaches_it():
    files = {"/r": SedFileText("R\n")}
    assert (await _run("p;0r /r", b"x\n", files=files))[0] == "x\nR\nx\n"
    assert (await _run("b;0r /r", b"x\n", files=files))[0] == "x\n"
    assert (await _run("1d;0r /r", b"x\ny\n", files=files))[0] == "y\n"


@pytest.mark.asyncio
async def test_quit_codes_and_the_empty_regex():
    _, _, code, machine = await _run("2q300", b"a\nb\nc\n")
    assert code == 44 and machine.stopped()
    out, err, code, _ = await _run("2{/a/p};1{//p}", b"a\nb\n", suppress=True)
    assert err == (
        "sed: -e expression #1, char 0: no previous regular expression\n"
    )
    assert code == 1
    out, _, _, _ = await _run("/a/I{s//x/p}", b"AB\n", suppress=True)
    assert out == "xB\n"


def test_a_script_file_read_whole_reports_every_failure_past_opening():
    assert unreadable_file("/r", FileNotFoundError(errno.ENOENT, "")) is None
    assert unreadable_file("/r", PermissionError(errno.EACCES, "")) is None
    assert unreadable_file("/r", IsADirectoryError(errno.EISDIR, "")) == (
        SedFileError("sed: read error on /r: Is a directory\n")
    )
    assert unreadable_file("/r", OSError(errno.EIO, "I/O error")) == (
        SedFileError("sed: read error on /r: Input/output error\n")
    )
