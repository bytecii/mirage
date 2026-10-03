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
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.builtins.variable_utils import _is_shift_count
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_return(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Return from a function or sourced script, with bash's checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the return status.
        session (Session): session whose last exit code is the default
            status and whose source depth marks sourced execution.
        call_stack (CallStack | None): active call stack; a pushed
            frame marks function execution.
    """
    in_function = call_stack is not None and call_stack.depth > 1
    if not in_function and session.source_depth == 0:
        # bash prints the diagnostic, sets $? to 2, and carries on with
        # the rest of the line.
        err = (b"return: can only `return' from a function "
               b"or sourced script\n")
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="return",
                                                         exit_code=2,
                                                         stderr=err)
    if args and not _is_shift_count(args[0]):
        # bash prints the error and the function returns 2.
        raise ReturnSignal(
            2,
            stderr=f"return: {args[0]}: numeric argument required\n".encode())
    if len(args) > 1:
        err = b"return: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="return",
                                                         exit_code=1,
                                                         stderr=err)
    # A bare return propagates the status of the last command executed.
    raise ReturnSignal(int(args[0]) % 256 if args else session.last_exit_code)


async def handle_exit(
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Exit the shell, with bash's argument checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the exit status.
        session (Session): session whose last exit code is the default
            status.
    """
    if args and not _is_shift_count(args[0]):
        # bash exits with 2 after the diagnostic.
        raise ExitSignal(
            2, stderr=f"exit: {args[0]}: numeric argument required\n".encode())
    if len(args) > 1:
        # bash refuses to exit and the command fails with 1.
        err = b"exit: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="exit",
                                                         exit_code=1,
                                                         stderr=err)
    code = int(args[0]) if args else session.last_exit_code
    raise ExitSignal(code % 256)
