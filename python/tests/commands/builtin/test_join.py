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


from tests.commands.builtin.conftest import output_bytes as _bytes
from tests.commands.builtin.conftest import ram_workspace as _ws
from tests.commands.builtin.conftest import run_raw as _run_raw


def test_join_reads_a_dash_operand_across_mounts():
    # From / the dash sits on the root mount, so the line relays.
    ws, _ = _ws()
    _run_raw(ws, "tee /data/f.txt", stdin=b"alice 30\nbob 25\n")
    stdout, io = _run_raw(ws, "join - /data/f.txt", stdin=b"alice 1\nbob 2\n")
    assert (_bytes(stdout), io.exit_code) == (b"alice 1 30\nbob 2 25\n", 0)


def test_join_refuses_two_dash_operands():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "join - -", stdin=b"a\n")
    assert io.exit_code == 1
    assert _bytes(io.stderr) == b"join: both files cannot be standard input\n"
