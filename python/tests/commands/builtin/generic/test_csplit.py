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

import pytest

from mirage.commands.builtin.generic.csplit import csplit
from mirage.types import PathSpec


async def _no_read(path: PathSpec) -> bytes:
    raise AssertionError(f"read {path.virtual}: the input is stdin")


@pytest.mark.asyncio
async def test_stdin_outputs_are_named_on_the_executing_mount():
    # No operand and no -f to read a prefix from: the executing mount's
    # prefix names the outputs, and the writes keys stay mount-relative.
    specs: list[PathSpec] = []

    async def write_bytes(path: PathSpec, data: bytes) -> None:
        specs.append(path)

    _, io = await csplit([], ["2"],
                         read_bytes=_no_read,
                         write_bytes=write_bytes,
                         stdin=b"a\nb\n",
                         mount_prefix="/data")
    assert [(p.virtual, p.vfs_path) for p in specs] == [
        ("/data/xx00", "xx00"),
        ("/data/xx01", "xx01"),
    ]
    assert list(io.writes) == ["/xx00", "/xx01"]


@pytest.mark.asyncio
async def test_a_prefix_path_is_named_on_the_executing_mount():
    specs: list[PathSpec] = []

    async def write_bytes(path: PathSpec, data: bytes) -> None:
        specs.append(path)

    prefix = PathSpec(virtual="/data/sub/cs",
                      directory="/data/sub/",
                      vfs_path="sub/cs")
    _, io = await csplit([], ["2"],
                         read_bytes=_no_read,
                         write_bytes=write_bytes,
                         stdin=b"a\nb\n",
                         prefix=prefix,
                         mount_prefix="/data")
    assert [p.virtual for p in specs] == ["/data/sub/cs00", "/data/sub/cs01"]
    assert list(io.writes) == ["/sub/cs00", "/sub/cs01"]
