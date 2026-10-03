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
from mirage.shell.arith import evaluate_arith
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError, ReadonlyError
from mirage.workspace.executor.types import ExecuteFn
from mirage.workspace.expand.node import expand_arith
from mirage.workspace.session import Session
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import (ensure_var_visible,
                                            session_elements, visible_env)


async def _eval_cfor_expr(
    expr: tree_sitter.Node | None,
    default: int,
    session: Session,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None,
    view: SessionView | None = None,
) -> int:
    """Evaluate one C-style for expression slot.

    Args:
        expr (tree_sitter.Node | None): expression node, or None for
            an empty slot.
        default (int): value an empty slot yields (1 for the condition
            so `for ((;;))` loops, 0 for init/update).
        session (Session): shell session; arithmetic assignments land
            in its env.
        execute_fn (Callable): recursive execute for substitutions.
        call_stack (CallStack | None): function-call scope, if any.
        view (SessionView | None): the session plane's gated door the
            assignments land through; None outside a workspace.

    Raises:
        ArithError: re-raised with the expression text prepended, so
            the loop can print bash's `((: expr: reason` diagnostic.
        ReadonlyError: the expression assigns to a readonly variable,
            which aborts the loop the same way an invalid expression
            does.
        PolicyDenied: a pre_session rule refused one of the writes.
    """
    if expr is None:
        return default
    text = await expand_arith(expr, session, execute_fn, call_stack, view=view)
    try:
        # Reads resolve against the visible env so a hidden name counts
        # as unset; a hidden write refuses through the session door
        # (ensure_var_visible), caught by the loop beside ReadonlyError.
        result = evaluate_arith(text,
                                visible_env(session),
                                elements=session_elements(session))
    except ArithError as exc:
        raise ArithError(f"{text}: {exc}") from exc
    for write in result.writes:
        ensure_var_visible(session, write.name)
        if write.name in session.readonly_vars:
            raise ReadonlyError(write.name)
    # Through the door, so a pre_session rule governs an arithmetic
    # assignment exactly as it governs `X=1`; in evaluation order, so
    # a bare name and its element 0 land as the expression wrote them.
    for write in result.writes:
        await assign_element(session, view, write.name, write.key, write.value)
    return int(result.value)
