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

from collections.abc import Awaitable
from typing import Protocol

import tree_sitter

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.console import JobConsole
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

ExecutionResult = tuple[ByteSource | None, IOResult, ExecutionNode]


class ExecuteNodeFn(Protocol):
    """Re-enter the statement walker without importing its implementation."""

    def __call__(
        self,
        node: tree_sitter.Node,
        session: Session,
        stdin: ByteSource | None,
        call_stack: CallStack | None,
        *,
        sink: JobConsole | None = None,
    ) -> Awaitable[ExecutionResult]:
        ...


class ExecuteFn(Protocol):

    def __call__(
        self,
        command: str,
        *,
        session_id: str,
        stdin: ByteSource | None = None,
    ) -> Awaitable[IOResult]:
        ...
