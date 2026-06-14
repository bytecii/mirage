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

import time

from mirage.workspace.history import ExecutionHistory
from mirage.workspace.types import ExecutionNode, ExecutionRecord


def _make_record(command: str = "echo hi",
                 agent: str = "test") -> ExecutionRecord:
    return ExecutionRecord(
        agent=agent,
        command=command,
        stdout=b"hi\n",
        stdin=None,
        exit_code=0,
        tree=ExecutionNode(command=command, stderr=b"", exit_code=0),
        timestamp=time.time(),
    )


def test_history_append_and_entries():
    h = ExecutionHistory(max_entries=100)
    r = _make_record()
    h.append(r)
    assert len(h.entries()) == 1
    assert h.entries()[0] is r


def test_history_max_entries():
    h = ExecutionHistory(max_entries=3)
    for i in range(5):
        h.append(_make_record(command=f"cmd-{i}"))
    assert len(h.entries()) == 3
    assert h.entries()[0].command == "cmd-2"
    assert h.entries()[-1].command == "cmd-4"


def test_history_clear():
    h = ExecutionHistory(max_entries=100)
    h.append(_make_record())
    h.clear()
    assert len(h.entries()) == 0


def test_history_entries_returns_copy():
    h = ExecutionHistory(max_entries=100)
    h.append(_make_record())
    entries = h.entries()
    entries.clear()
    assert len(h.entries()) == 1
