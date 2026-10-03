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

from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError, ExitSignal
from mirage.shell.syntax.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import ShellValue
from mirage.types import word_text
from mirage.workspace.executor.types import ExecuteFn
from mirage.workspace.expand import expand_and_classify, expand_node
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.constants import _SUBSCRIPT_LITERAL_TYPES
from mirage.workspace.session import Session
from mirage.workspace.session.state import session_view


async def _assign_var(view: SessionView, key: str, value: ShellValue) -> None:
    """One assignment through the session door; denial is fatal.

    Every assignment spelling (scalar, array literal, subscript,
    append) computes its resulting value and stores through
    ``view.set``, so the gate and the storage invariant live in the
    door, not here. Denial mirrors the readonly case: a fatal
    variable-assignment error that abandons the rest of the line.

    Args:
        view (SessionView): the session plane's gated door.
        key (str): the variable being written.
        value (ShellValue): the resulting value to store.
    """
    try:
        await view.set(key, value)
    except PolicyDenied as exc:
        err = f"{exc.strerror}\n".encode()
        raise ExitSignal(1, stderr=err, contained_code=1) from exc
    except ArithError as exc:
        # The `-i` coercion refused the text. GNU aborts the line the
        # way a bad subscript does, voicing the evaluator's own message
        # after the offending value: `bash: 1+: syntax error: ...`.
        err = f"bash: {exc}\n".encode()
        raise ExitSignal(1, stderr=err, contained_code=1) from exc


async def _expand_array_items(
    array_node: tree_sitter.Node,
    session: Session,
    execute_fn: ExecuteFn,
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
) -> list[str]:
    """Expand an array literal into its element words.

    Elements behave like any other shell word list: command
    substitutions word-split and globs resolve to matches
    (``a=($(cmd) /data/*.txt)``), with zero-match globs kept literal.

    Args:
        array_node (tree_sitter.Node): the tree-sitter ``array`` node.
        session (Session): shell session.
        execute_fn (Callable): workspace execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
    """
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(session, registry.policies)
    values = list(array_node.named_children)
    classified = await expand_and_classify(values,
                                           session,
                                           execute_fn,
                                           registry,
                                           session.cwd,
                                           cs,
                                           view=view)
    resolved = await resolve_globs(classified,
                                   registry,
                                   noglob=bool(
                                       session.shell_options.get("noglob")),
                                   links=namespace,
                                   options=glob_options(session))
    return [word_text(w) for w in resolved]


async def _subscript_key_text(
    subscript_node: tree_sitter.Node,
    name: str,
    session: Session,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None,
) -> str:
    """The expanded subscript text of one ``name[...]=`` assignment.

    A purely literal subscript keeps its raw spelling, spaces included
    (bash stores ``m[ k ]`` under the key ``" k "``); anything carrying
    an expansion or quoting expands node by node so ``m[$k]`` and
    ``m["a b"]`` resolve with quote removal. The associative path uses
    the result as the key verbatim; the indexed path evaluates it as
    arithmetic.

    Args:
        subscript_node (tree_sitter.Node): the tree-sitter ``subscript`` node.
        name (str): the array variable's name, for the raw slice.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        cs (CallStack | None): shell call stack.
        view (SessionView | None): the session plane's gated door.
    """
    inner = [
        sc for sc in subscript_node.named_children
        if sc.type != NT.VARIABLE_NAME
    ]
    raw = get_text(subscript_node)[len(name) + 1:-1]
    if not inner or all(sc.type in _SUBSCRIPT_LITERAL_TYPES for sc in inner):
        return raw
    parts = []
    for sc in inner:
        parts.append(await expand_node(sc, session, execute_fn, cs, view=view))
    return "".join(parts)
