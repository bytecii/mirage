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
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.types import ExecutionResult
from mirage.workspace.node.constants import (_ATTR_LETTERS, _DECLARE_LETTERS,
                                             _DECLARE_USAGE)
from mirage.workspace.session import Session
from mirage.workspace.session.state import set_attr
from mirage.workspace.types import ExecutionNode


def _merge_conversion_errors(
    result: ExecutionResult,
    errors: list[str],
) -> ExecutionResult:
    """Fold kind-conversion refusals into a declaration's result.

    GNU reports `cannot convert indexed to associative array` per
    refused name on stderr and fails the builtin with 1 while the other
    operands still declare, so the refusals ride the handler's own
    result rather than replacing it.

    Args:
        result (tuple): the handler's (stream, io, node) answer.
        errors (list[str]): the refusal lines, in operand order.
    """
    if not errors:
        return result
    stream, io, node = result
    extra = ("\n".join(errors) + "\n").encode()
    prior = io.stderr if isinstance(io.stderr, bytes) else b""
    merged = prior + extra
    new_io = IOResult(exit_code=1,
                      stderr=merged,
                      reads=io.reads,
                      writes=io.writes,
                      cache=io.cache)
    new_node = ExecutionNode(command=node.command, exit_code=1, stderr=merged)
    return stream, new_io, new_node


def _declare_option_refusal(
    cmd: str,
    flag_chars: set[str],
    plus_chars: set[str],
    session: Session,
) -> ExecutionResult | None:
    """The refusal a `declare` family option cluster earns, if any.

    An unknown letter is GNU's `invalid option` plus the usage line,
    exit 2, and it wins over every other check because bash refuses
    the cluster before it looks at a single operand.

    Args:
        cmd (str): the builtin's own name for the diagnostic.
        flag_chars (set[str]): the `-` letters, `--` excluded.
        plus_chars (set[str]): the `+` letters.
        session (Session): shell session state (unused today, kept so
            a later check that reads it does not change the signature).
    """
    bad = next((c for c in sorted(flag_chars | plus_chars)
                if c not in _DECLARE_LETTERS), None)
    if bad is None:
        return None
    sign = "-" if bad in flag_chars else "+"
    err = (f"bash: {cmd}: {sign}{bad}: invalid option\n"
           f"{_DECLARE_USAGE}\n").encode()
    return None, IOResult(exit_code=2, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=2,
                                                                  stderr=err)


async def _plus_refusals(
    cmd: str,
    session: Session,
    view: SessionView,
    plus_chars: set[str],
    assignments: list[str],
    staged: list[tuple[str, bool, list[str]]] | None,
) -> ExecutionResult | None:
    """The per-name refusals a `+letter` earns after the operands are
    known.

    Two letters cannot be taken off. `+r` on a readonly name is
    `declare: R: readonly variable`, exit 1, and the name stays frozen.
    `+a` / `+A` on an array is `cannot destroy array variables in this
    way`, exit 1, since the kind is what the value is, not a mark. Both
    are pinned on 5.2.37 and neither stops the other operands from
    declaring; the first refusal is what the builtin reports.

    Args:
        cmd (str): the builtin's own name for the diagnostic.
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        plus_chars (set[str]): the `+` letters.
        assignments (list[str]): `NAME` / `NAME=value` operands.
        staged (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the same declaration.
    """
    if not (plus_chars & {"r", "a", "A"}):
        return None
    names = [a.partition("=")[0] for a in assignments]
    names += [name for name, _, _ in staged or []]
    for name in names:
        if "r" in plus_chars and view.is_readonly(name):
            err = f"bash: {cmd}: {name}: readonly variable\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=cmd,
                                                             exit_code=1,
                                                             stderr=err)
        if (("a" in plus_chars and name in session.arrays)
                or ("A" in plus_chars and name in session.assocs)):
            err = (f"bash: {cmd}: {name}: cannot destroy array variables "
                   "in this way\n").encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=cmd,
                                                             exit_code=1,
                                                             stderr=err)
    return None


async def _stamp_attrs(
    session: Session,
    view: SessionView,
    flag_chars: set[str],
    plus_chars: set[str],
    assignments: list[str],
    staged: list[tuple[str, bool, list[str]]] | None,
    stored: list[str],
) -> ExecutionResult | None:
    """Apply every `-attr` / `+attr` letter to the names a declaration
    stored, on top of the export stamp.

    The letters that shape a value (`-i -l -u`) are stored as
    attributes and applied by the door on every *later* write, which is
    GNU's rule: `v=MiXeD; declare -l v` keeps `MiXeD`, and the next
    `v=ABC` stores `abc`. So this stamps and never rewrites. `-l` and
    `-u` are exclusive: setting one clears the other, and a cluster
    naming both (`-lu`, `-ul`) sets neither, both pinned on 5.2.37.
    A `+` letter clears; `+r` is refused by the door as a readonly write
    would be, in the builtin's voice.

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        flag_chars (set[str]): the `-` letters.
        plus_chars (set[str]): the `+` letters.
        assignments (list[str]): `NAME` / `NAME=value` operands.
        staged (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the same declaration.
        stored (list[str]): the names the handler actually stored.
    """
    refused = await _stamp_export(session, view, flag_chars, assignments,
                                  staged, stored)
    if refused is not None:
        return refused
    on_attrs = [
        _ATTR_LETTERS[c] for c in "ilunt"
        if c in flag_chars and c not in plus_chars
    ]
    if "l" in flag_chars and "u" in flag_chars:
        on_attrs = [
            a for a in on_attrs if a not in (VarAttr.LOWER, VarAttr.UPPER)
        ]
    # `+r` is refused earlier on a readonly name and a no-op otherwise,
    # so it is not an off toggle; every other stored letter clears.
    off_attrs = [_ATTR_LETTERS[c] for c in "iluntx" if c in plus_chars]
    if not on_attrs and not off_attrs:
        return None
    # Through the gated mark door for every name, covered or not: the
    # handler already cleared the gate for these names, so this is one
    # redundant policy call per attribute, and it keeps this stamp out
    # of the ungated-write allowlist that `set_attr` sites must justify.
    try:
        for name in stored:
            for attr in on_attrs:
                await view.mark(name, attr, True)
                # `-l` displaces `-u` and vice versa; the record keeps one.
                if attr == VarAttr.LOWER:
                    await view.mark(name, VarAttr.UPPER, False)
                elif attr == VarAttr.UPPER:
                    await view.mark(name, VarAttr.LOWER, False)
            for attr in off_attrs:
                await view.mark(name, attr, False)
    except PolicyDenied as exc:
        err = f"{exc.strerror}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="declare",
                                                         exit_code=1,
                                                         stderr=err)
    return None


async def _stamp_export(
    session: Session,
    view: SessionView,
    flag_chars: set[str],
    assignments: list[str],
    staged: list[tuple[str, bool, list[str]]] | None,
    stored: list[str],
) -> ExecutionResult | None:
    """Mark every name a `-x` declaration stored as exported.

    `declare -x NAME` marks an existing name without touching its value
    and `declare -x NAME=v` assigns then marks, so the stamp lands after
    the assignment either way. Staged array literals are stamped too,
    since an array is as exportable as a scalar: GNU answers
    `declare -x A=(a b)` with `declare -ax A=([0]="a" [1]="b")`, and
    reading only `assignments` left every `declare -x NAME=(...)`
    unmarked.

    Shared by the readonly and the plain declaration branch because
    `declare -rx X=1` goes down the readonly one and still owes the
    export attribute.

    Only the names the handler reports storing are marked, and marking
    is not gated on the aggregate status: a declaration keeps its valid
    operands when a sibling refuses, so `declare -x GOOD=1 1BAD=x` exits
    1 and still answers `declare -x GOOD="1"`. Reading the exit code
    instead left `GOOD` unexported.

    A name that carried a value went through `view.set`, so its mark
    rides on that decision; a bare name did not, and on an *existing*
    name the handler writes nothing at all, so the mark is the only
    session write there is and has to clear `pre_session` itself.
    Stamping it through `set_attr` let `declare -x AWS_TOKEN` export a
    host-seeded credential the deployment had refused.

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        flag_chars (set[str]): the declaration's collected flag letters.
        assignments (list[str]): `NAME` / `NAME=value` operands.
        staged (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the same declaration.
        stored (list[str]): the names the handler actually stored.

    Returns:
        A refusal result when the gate denied a mark, else None.
    """
    if "x" not in flag_chars:
        return None
    covered = {a.partition("=")[0] for a in assignments if "=" in a}
    covered |= {name for name, _, _ in staged or []}
    for name in stored:
        if name in covered:
            set_attr(session, name, VarAttr.EXPORT)
            continue
        try:
            await view.mark(name, VarAttr.EXPORT, True)
        except PolicyDenied as exc:
            err = f"{exc.strerror}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="declare",
                                                             exit_code=1,
                                                             stderr=err)
    return None
