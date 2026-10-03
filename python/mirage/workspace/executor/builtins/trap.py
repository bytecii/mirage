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

from mirage.io import IOResult
from mirage.workspace.executor.builtins.constants import (_TRAP_EXIT_NAMES,
                                                          _TRAP_USAGE)
from mirage.workspace.executor.types import ExecutionResult
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_trap(args: list[str], session: Session) -> ExecutionResult:
    """Register or inspect EXIT cleanup for a virtual shell scope.

    Signal delivery is not modelled by Mirage's job cancellation API.
    Refuse other events instead of accepting handlers that cannot run.

    Args:
        args (list[str]): words after trap.
        session (Session): shell that owns the handler.
    """
    words = list(args)
    printing = not words
    if words and words[0] == "-p":
        printing = True
        words.pop(0)
    elif words and words[0] == "--":
        words.pop(0)
        printing = not words
    elif words and words[0].startswith("-") and words[0] != "-":
        err = f"trap: {words[0]}: unsupported option\n{_TRAP_USAGE}".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="trap",
                                                         exit_code=2,
                                                         stderr=err)
    action = None
    if not printing:
        # A lone numeric signal resets it; a lone action is a usage error.
        if words and words[0] == "0":
            action = "-"
        else:
            action = words.pop(0) if words else None
            if not words:
                err = _TRAP_USAGE.encode()
                return None, IOResult(exit_code=2, stderr=err), ExecutionNode(
                    command="trap", exit_code=2, stderr=err)
    errors: list[str] = []
    output: list[str] = []
    for name in words or ["EXIT"]:
        if name not in _TRAP_EXIT_NAMES:
            errors.append(
                f"trap: {name}: unsupported event (supported: EXIT)\n")
            continue
        if printing:
            if session.exit_trap is not None:
                quoted = session.exit_trap.replace("'", "'\\''")
                output.append(f"trap -- '{quoted}' EXIT\n")
        else:
            session.exit_trap = None if action == "-" else action
            session.exit_trap_inherited = False
    err = "".join(errors).encode()
    code = 1 if errors else 0
    return "".join(output).encode(), IOResult(
        exit_code=code, stderr=err), ExecutionNode(command="trap",
                                                   exit_code=code,
                                                   stderr=err)
