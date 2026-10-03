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
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.errors import ArithError
from mirage.workspace.executor.builtins.constants import _IDENTIFIER_RE
from mirage.workspace.session import Session
from mirage.workspace.session.state import session_view
from mirage.workspace.types import ExecutionNode


def _view(session: Session, state: SessionView | None) -> SessionView:
    """The session view to write through.

    Production callers thread the workspace's gated view; a direct
    invocation (a unit test) gets an ungated one over the same session.

    Args:
        session (Session): shell session state.
        state (SessionView | None): the caller's view, if threaded.
    """
    return state if state is not None else session_view(session)


def _refusal(
        cmd: str, exc: PolicyDenied
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Render a policy denial in the builtin's own voice.

    Args:
        cmd (str): builtin name for the node.
        exc (PolicyDenied): the gate's refusal.
    """
    err = f"{exc.strerror}\n".encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


def _readonly_refusal(
        cmd: str,
        name: str) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Render the shell's own readonly refusal, checked before the door.

    Args:
        cmd (str): builtin name for the node.
        name (str): the frozen variable.
    """
    err = f"bash: {name}: readonly variable\n".encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


def _arith_refusal(
        cmd: str,
        exc: ArithError) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Render the ``-i`` coercion's arithmetic error as bash does.

    GNU voices it as the evaluator's own line, prefixed by the builtin
    and the offending text (``bash: read: 1+: syntax error: operand
    expected``), and fails the builtin with 1 while the variable keeps
    its old value, which is what the door's copy-then-store already
    guarantees. A plain assignment (``n=1+``) is fatal instead and is
    voiced by the executor without a builtin name.

    Args:
        cmd (str): builtin name for the node.
        exc (ArithError): the evaluator's refusal, text already led.
    """
    err = f"bash: {cmd}: {exc}\n".encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


def _is_shift_count(word: str) -> bool:
    body = word[1:] if word[:1] in ("-", "+") else word
    return body.isdigit()


def _is_valid_name(name: str) -> bool:
    return _IDENTIFIER_RE.fullmatch(name) is not None
