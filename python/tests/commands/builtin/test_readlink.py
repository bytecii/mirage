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


from tests.commands.builtin.conftest import file_workspace as _ws
from tests.commands.builtin.conftest import optional_output_bytes as _bytes
from tests.commands.builtin.conftest import run_raw as _run_raw


def test_readlink():
    ws = _ws(**{"/f.txt": b"x"})
    stdout, _ = _run_raw(ws, "readlink -f /data/f.txt")
    assert b"/f.txt" in _bytes(stdout)
