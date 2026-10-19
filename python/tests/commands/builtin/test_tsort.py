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


def test_tsort_simple():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "tsort", stdin=b"a b\nb c\n")
    assert _bytes(stdout).strip() == b"a\nb\nc"


def test_tsort_cycle():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "tsort", stdin=b"a b\nb a\n")
    assert io.exit_code == 1
