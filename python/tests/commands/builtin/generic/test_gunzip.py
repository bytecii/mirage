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
import gzip

import pytest

from mirage.commands.builtin.generic.gunzip import gunzip_writes
from mirage.commands.spec import SPECS
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command.flags import parse_flags


@pytest.mark.parametrize("argv,writes", [
    ([], False),
    (["-c", "f.txt.gz"], False),
    (["-t", "f.txt.gz"], False),
    (["f.txt.gz"], True),
    (["-k", "f.txt.gz"], True),
])
def test_gunzip_writes_only_the_files_it_replaces(argv: list[str],
                                                  writes: bool):
    parsed = parse_flags(argv, SPECS["gunzip"], "gunzip", "/data")
    assert gunzip_writes(parsed.flag_kwargs, parsed.paths) is writes


@pytest.mark.asyncio
async def test_a_dash_goes_to_stdout_while_files_decompress_in_place():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/b.txt > /dev/null", stdin=b"file\n")
    r = await ws.shell(
        "cd /data && gzip b.txt && gunzip - b.txt.gz; ls; cat b.txt",
        stdin=gzip.compress(b"hi\n"))
    assert await r.materialize_stdout() == b"hi\nb.txt\nfile\n"


def test_gunzip_writes_nothing_for_a_dash_operand():
    # A `-` has no file to replace: gunzip decompresses stdin to stdout.
    dash = PathSpec(virtual="/data/-",
                    directory="/data/",
                    vfs_path="-",
                    resolved=True,
                    raw_path="-")
    flags = parse_flags([], SPECS["gunzip"], "gunzip", "/data").flag_kwargs
    assert gunzip_writes(flags, [dash]) is False

