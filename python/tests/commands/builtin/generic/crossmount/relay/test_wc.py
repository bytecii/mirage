import pytest

from mirage.commands.builtin.generic.crossmount.relay.wc import run_wc
from mirage.io.types import IOResult, materialize
from mirage.types import FileStat, FileType, PathSpec


@pytest.mark.asyncio
@pytest.mark.parametrize("flags,expected", [
    ({
        "lines": True
    }, b"      0 /a/dir\n      1 /b/name with spaces\n      1 total\n"),
    ({
        "lines": True,
        "total": "only"
    }, b"1\n"),
    ({
        "lines": True,
        "total": "never"
    }, b"      0 /a/dir\n      1 /b/name with spaces\n"),
])
async def test_counts_preserve_operand_type_and_whitespace(flags, expected):

    async def dispatch(op, path, **kwargs):
        if op == "stat":
            is_dir = path.virtual == "/a/dir"
            kind = FileType.DIRECTORY if is_dir else FileType.FILE
            return FileStat(name=path.virtual, type=kind), IOResult()
        assert path.virtual != "/a/dir"
        return b"hello\n", IOResult()

    paths = [
        PathSpec.from_str_path(p) for p in ("/a/dir", "/b/name with spaces")
    ]
    body, io = await run_wc(paths, flags, dispatch)
    assert await materialize(body) == expected
    assert io.exit_code == 1
    assert io.stderr == b"wc: /a/dir: Is a directory\n"


@pytest.mark.asyncio
async def test_invalid_total_fails_before_dispatch():
    calls = []

    async def dispatch(op, path, **kwargs):
        calls.append(op)
        return None, IOResult()

    _, io = await run_wc([PathSpec.from_str_path("/a/x")], {"total": "bogus"},
                         dispatch)
    assert io.exit_code == 1
    assert b"invalid argument 'bogus'" in io.stderr
    assert calls == []
