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

import asyncio
import zlib

import pytest

from mirage.commands.builtin.generic.gzip import extract_level, gzip_writes
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command.flags import parse_flags


def _level(argv: list[str]) -> int:
    parsed = parse_flags(argv, SPECS["gzip"], "gzip", "/")
    return extract_level(FlagView(parsed.flag_kwargs, spec=SPECS["gzip"]))


@pytest.mark.parametrize("digit", list(range(1, 10)))
def test_every_digit_flag_selects_its_level(digit: int):
    """-1..-9 each select their own level, including -1.

    ``-1`` is the one digit the parser disambiguates (``args_1``), so a
    bag read by the bare digit missed it and silently compressed at
    zlib's default.
    """
    assert _level([f"-{digit}"]) == digit


def test_no_digit_flag_keeps_the_zlib_default():
    assert _level([]) == zlib.Z_DEFAULT_COMPRESSION


def test_the_highest_digit_wins():
    """GNU takes the last level flag; the parser leaves all of them set."""
    assert _level(["-1", "-9"]) == 9


@pytest.mark.parametrize("argv,writes", [
    ([], False),
    (["-d"], False),
    (["-c", "f.txt"], False),
    (["-dc", "f.txt.gz"], False),
    (["f.txt"], True),
    (["-k", "f.txt"], True),
    (["-d", "f.txt.gz"], True),
])
def test_gzip_writes_only_the_files_it_replaces(argv: list[str], writes: bool):
    parsed = parse_flags(argv, SPECS["gzip"], "gzip", "/data")
    assert gzip_writes(parsed.flag_kwargs, parsed.paths) is writes


def test_a_read_only_mount_runs_gzip_where_it_writes_nothing():
    vfs = RAMVFS()
    vfs._store.files["/f.txt"] = b"hello\n"
    ws = Workspace({"/ro/": (vfs, MountMode.READ)})

    async def run():
        return (await
                ws.shell("cd /ro && printf 'x\\n' | gzip | gunzip"), await
                ws.shell("gzip -c /ro/f.txt | gunzip"), await
                ws.shell("gzip /ro/f.txt"))

    piped, to_stdout, in_place = asyncio.run(run())
    assert (piped.exit_code, piped.stdout, piped.stderr) == (0, b"x\n", None)
    assert (to_stdout.exit_code, to_stdout.stdout) == (0, b"hello\n")
    assert in_place.exit_code == 1
    assert in_place.stderr == b"gzip: read-only mount at /ro/\n"
    assert sorted(vfs._store.files) == ["/f.txt"]


@pytest.mark.asyncio
async def test_a_dash_goes_to_stdout_while_files_compress_in_place():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/a.txt > /dev/null", stdin=b"file\n")
    r = await ws.shell("cd /data && gzip - a.txt | gzip -dc; ls",
                       stdin=b"hi\n")
    assert await r.materialize_stdout() == b"hi\na.txt.gz\n"


def _operand(raw: str) -> PathSpec:
    return PathSpec(virtual=f"/data/{raw}",
                    directory="/data/",
                    vfs_path=raw,
                    resolved=True,
                    raw_path=raw)


def test_gzip_writes_nothing_for_a_dash_operand():
    # A `-` has no file to replace: gzip compresses stdin to stdout.
    flags = parse_flags([], SPECS["gzip"], "gzip", "/data").flag_kwargs
    assert gzip_writes(flags, [_operand("-")]) is False
    assert gzip_writes(flags, [_operand("-"), _operand("f.txt")]) is True


def test_a_read_only_mount_runs_gzip_and_gunzip_on_a_dash():
    ws = Workspace({"/ro/": (RAMVFS(), MountMode.READ)})
    io = asyncio.run(ws.shell("cd /ro && printf 'x\\n' | gzip - | gunzip -"))
    assert (io.exit_code, io.stdout, io.stderr) == (0, b"x\n", None)

