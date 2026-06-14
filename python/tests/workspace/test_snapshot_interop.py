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

from pathlib import Path

import pytest

from mirage.resource.ram import RAMResource
from mirage.workspace.workspace import Workspace

_FIXTURE = Path(__file__).parent / "__fixtures__" / "ts_ram.tar"


@pytest.mark.asyncio
async def test_loads_typescript_written_ram_tar() -> None:
    ws = Workspace.load(str(_FIXTURE), resources={"/ram": RAMResource()})
    r = await ws.execute("cat /ram/f.txt")
    assert r.exit_code == 0
    assert await r.stdout_str() == "one\ntwo\nthree\n"
