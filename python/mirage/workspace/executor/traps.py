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
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.types import ExecuteFn, ExecutionResult
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def finish_shell(execute_fn: ExecuteFn | None, session: Session,
                       result: ExecutionResult) -> ExecutionResult:
    """Await EXIT cleanup before releasing a completed shell's state.

    Cancellation is a hard stop, not a simulated POSIX signal. Callers
    invoke this only after normal completion or an explicit shell exit.
    A handler uses the ordinary async evaluator, policies and redirects.

    Args:
        execute_fn (ExecuteFn | None): evaluator, absent in isolated walkers.
        session (Session): scope being ended.
        result (ExecutionResult): body output and final status.
    """
    stdout, io, node = result
    action = session.exit_trap
    if (execute_fn is None or not action or session.exit_trap_inherited
            or session.running_exit_trap
            or session.shell_options.get("noexec")):
        return result
    before = await materialize(stdout)
    code = io.exit_code
    session.last_exit_code = code
    session.running_exit_trap = True
    depth = session.eval_depth
    # An exit inside cleanup must unwind to here, even when the caller
    # is a job or subshell with no active program frame.
    session.eval_depth = 1
    try:
        try:
            cleanup = await execute_fn(action, session_id=session.session_id)
        except ExitSignal as sig:
            code = sig.exit_code
            cleanup = IOResult(stdout=sig.stdout,
                               stderr=sig.stderr,
                               exit_code=code)
        after = await materialize(cleanup.stdout)
        merged = await io.merge(cleanup)
        merged.exit_code = code
        merged.stdout = before + after
        node.exit_code = code
        session.last_exit_code = code
        return merged.stdout, merged, node
    finally:
        session.eval_depth = depth
        session.running_exit_trap = False
        # Re-registering an EXIT handler from inside itself cannot make
        # this scope exit twice.
        session.exit_trap = None


async def execute_child_shell(execute_fn: ExecuteFn,
                              session: Session,
                              script: str,
                              stdin: ByteSource | None = None) -> IOResult:
    """Capture a command or input process substitution in its own scope.

    Args:
        execute_fn (ExecuteFn): nested evaluator.
        session (Session): parent, restored after the child finishes.
        script (str): substitution body.
        stdin (ByteSource | None): optional child input.
    """
    saved = session.snapshot()
    session.exit_trap_inherited = True
    session.running_exit_trap = False
    session.eval_depth = 0
    session.source_depth = 0
    try:
        io = await execute_fn(script,
                              session_id=session.session_id,
                              stdin=stdin)
        # The evaluator handles explicit exit; EOF needs the same cleanup.
        from_node = ExecutionNode(command="$()", exit_code=io.exit_code)
        _, io, _ = await finish_shell(execute_fn, session,
                                      (io.stdout, io, from_node))
        return io
    finally:
        session.restore(saved)
