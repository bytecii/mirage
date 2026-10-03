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

import tree_sitter

from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.call_stack import CallStack
from mirage.shell.syntax.helpers import get_redirects
from mirage.shell.syntax.node_kind import NodeKind, node_kind
from mirage.shell.types import Redirect, RedirectKind
from mirage.workspace.executor.redirect import handle_redirect
from mirage.workspace.executor.types import (ExecuteFn, ExecuteNodeFn,
                                             ExecutionResult)
from mirage.workspace.expand import expand_redirects
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.session.state import session_view


async def _recurse_reassociated(
    recurse: ExecuteNodeFn,
    dispatch: DispatchFn,
    execute_fn: ExecuteFn,
    registry: MountRegistry,
    redirects: list[Redirect],
    right: tree_sitter.Node,
    node: tree_sitter.Node,
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> ExecutionResult:
    """Recurse wrapper for a re-associated trailing redirect.

    Executes the list's last command with the hoisted redirects,
    expanding targets only at that point (after the left side ran, so
    cwd changes apply); every other node recurses normally.

    Args:
        recurse (Callable): the plain execute_node recursion.
        dispatch (DispatchFn): VFS op dispatcher.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry.
        redirects (list): parsed redirects hoisted off the list.
        right (tree_sitter.Node): the list's last command node.
        node (tree_sitter.Node): node being executed by handle_connection.
        session (Session): shell session state.
        stdin (ByteSource | None): input stream.
        call_stack (CallStack | None): shell call stack.
    """
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(session, registry.policies)
    if node is not right:
        return await recurse(node, session, stdin, call_stack)
    expanded, pipe_node = await expand_redirects(redirects,
                                                 session,
                                                 execute_fn,
                                                 registry,
                                                 call_stack,
                                                 view=view)
    stdout, io, exec_node = await handle_redirect(recurse, dispatch, right,
                                                  expanded, session, stdin,
                                                  call_stack)
    if pipe_node is not None and stdout is not None:
        stdout, io2, exec_node2 = await recurse(pipe_node, session, stdout,
                                                call_stack)
        io = await io.merge(io2)
        exec_node = exec_node2
    return stdout, io, exec_node


async def _recurse_pipe_stderr(
    recurse: ExecuteNodeFn,
    dispatch: DispatchFn,
    execute_fn: ExecuteFn,
    registry: MountRegistry,
    targets: list[tree_sitter.Node],
    node: tree_sitter.Node,
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> ExecutionResult:
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(session, registry.policies)
    if node not in targets or node_kind(node) != NodeKind.REDIRECT:
        return await recurse(node, session, stdin, call_stack)
    command, redirects = get_redirects(node)
    redirects.append(
        Redirect(fd=2, target=1, kind=RedirectKind.STDERR_TO_STDOUT))
    expanded, pipe_node = await expand_redirects(redirects,
                                                 session,
                                                 execute_fn,
                                                 registry,
                                                 call_stack,
                                                 view=view)
    stdout, io, exec_node = await handle_redirect(recurse, dispatch, command,
                                                  expanded, session, stdin,
                                                  call_stack)
    if pipe_node is not None and stdout is not None:
        stdout, io2, exec_node2 = await recurse(pipe_node, session, stdout,
                                                call_stack)
        io = await io.merge(io2)
        exec_node = exec_node2
    return stdout, io, exec_node
