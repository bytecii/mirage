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

from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.generic.crossmount.relay.relay import run_relay
from mirage.io.types import IOResult
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_relay_rejects_wrong_strategy_before_dispatch():
    dispatch = AsyncMock()
    run_single = AsyncMock()
    with pytest.raises(
        ValueError, match="Unsupported cross-mount relay command: cat"
    ):
        await run_relay("cat", [], [], {}, dispatch, run_single)
    dispatch.assert_not_called()
    run_single.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("cmd", ["awk", "bc"])
async def test_one_run_resolves_on_its_first_files_mount_alone(cmd):
    # Resolving on every operand would check /b/two against /a/'s backend.
    run_single = AsyncMock(return_value=(None, IOResult()))
    scopes = [
        PathSpec.from_str_path("/a/one"),
        PathSpec.from_str_path("/b/two"),
    ]
    await run_relay(cmd, scopes, [], {}, AsyncMock(), run_single)
    run_single.assert_awaited_once()
    assert run_single.await_args.kwargs["resolve_hint"] is scopes[0]
