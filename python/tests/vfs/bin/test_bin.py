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

from mirage.vfs.bin import BinViewVFS


def test_view_registers_reads_and_no_writes():
    vfs = BinViewVFS(lambda: ["ls"], lambda n: n == "ls")
    names = {cmd.name for cmd in vfs.commands()}
    assert {"cat", "ls", "stat"} <= names
    assert not {"rm", "touch", "cp"} & names
    ops = {op.name for op in vfs.ops_list()}
    assert {"read", "readdir", "stat"} <= ops
    assert "write" not in ops
