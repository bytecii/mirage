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

import functools

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.arith import evaluate_arith
from mirage.shell.array import (array_extent, array_unset, build_assoc_literal,
                                build_indexed_literal)
from mirage.shell.errors import ArithError, ExitSignal
from mirage.shell.variable import ShellValue, VarAttr
from mirage.utils.hidden import var_hidden
from mirage.workspace.executor.builtins.constants import (_EXPORT_FLAGS,
                                                          _EXPORT_USAGE,
                                                          _READONLY_FLAGS,
                                                          _READONLY_USAGE,
                                                          _SUBSCRIPT_RE)
from mirage.workspace.executor.builtins.text import _PRINTF_TARGET_RE
from mirage.workspace.executor.builtins.variable_format import (
    _declare_line, _export_lines, _identifier_failure, _identifier_refusal,
    _readonly_lines, _split_decl_flags)
from mirage.workspace.executor.builtins.variable_utils import (
    _arith_refusal, _is_valid_name, _readonly_refusal, _refusal, _view)
from mirage.workspace.expand.variable import _array_index
from mirage.workspace.session import Session
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import (deref, element_index,
                                            ensure_var_visible, env_get,
                                            session_elements, set_attr,
                                            visible_arrays, visible_assocs,
                                            visible_env)
from mirage.workspace.types import ExecutionNode


async def _premark(view: SessionView, name: str,
                   shaping: frozenset[VarAttr]) -> None:
    """Put a declaration's value-shaping attributes on a name before its
    value stores.

    The door coerces on write by reading the record's attributes, so
    for the declaration's *own* value to coerce (``declare -i n=3+4``
    stores ``7``), the attribute has to be there first. Gated through
    ``view.mark`` like every other mark, and a no-op with nothing to
    shape, so a plain ``declare X=1`` costs no extra gate call.

    Args:
        view (SessionView): the session plane's gated door.
        name (str): the variable being declared.
        shaping (frozenset[VarAttr]): the ``-i -l -u`` attributes set.
    """
    for attr in shaping:
        await view.mark(name, attr, True)


async def _store_staged_arrays(
    cmd: str,
    session: Session,
    view: SessionView,
    arrays: list[tuple[str, bool, list[str]]],
    mark: VarAttr | None = None,
    on: bool = True,
    fatal: bool = False,
    stored: list[str] | None = None,
    assoc: bool = False,
    errors: list[str] | None = None,
    shaping: frozenset[VarAttr] = frozenset(),
    global_scope: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode] | None:
    """Store a declaration's array literals through the session door.

    The builtin owns the store; readonly is the shell's rule, checked
    per name before the door, and the door's gate covers the policy
    half. Names are processed in order, so an earlier operand stays
    stored when a later one refuses, as bash does. A readonly refusal
    of an array literal is a variable-assignment error in GNU, not a
    builtin failure: for `export`/`readonly` (and `declare` at top
    level) the rest of the line is abandoned, while `local` and a
    function-scoped `declare` refuse in the builtin's voice and the
    body keeps running (pinned on bash 5.2, debian:stable-slim).

    Args:
        cmd (str): builtin name for refusal rendering.
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        arrays (list[tuple[str, bool, list[str]]]): staged
            ``(name, append, items)`` literals from the declaration.
        mark (VarAttr | None): the attribute the declaring keyword puts
            on each stored name -- READONLY for ``readonly``, EXPORT for
            ``export``. An attribute rather than a bool because both
            keywords stage array literals through here and hardcoding
            one of them silently dropped the other: ``export ARR=(a b)``
            stored the array and never marked it, so GNU's
            ``declare -ax`` came out ``declare -a``.
        on (bool): the direction of that mark. ``export -n ARR=(b)``
            stores the array and takes the attribute *off*, and the
            store keeps whatever the name already carried, so leaving
            the mark unapplied left an exported array exported.
        fatal (bool): render a readonly refusal as the fatal
            assignment error instead of a builtin failure.
        stored (list[str] | None): filled with each name that actually
            stored, in order. A declaration keeps its valid operands
            when a sibling refuses, so the caller cannot read "what was
            written" off the aggregate exit status.
        assoc (bool): the declaration carried ``-A``, so every literal
            builds an associative map. Without it a name that already
            holds one still builds a map, since a plain
            ``m+=([k]=v)`` keeps the variable's own kind.
        errors (list[str] | None): filled with bash-voiced refusal
            lines for the plain words a keyed associative literal
            cannot take; the caller folds them into its exit status,
            because GNU stores the valid elements and still fails the
            builtin.
        shaping (frozenset[VarAttr]): the value-shaping attributes to
            put on each name before its literal stores.
        global_scope (bool): the declaration carried ``-g``, so no
            local snapshot is taken for the names.

    Returns:
        The refusal result, or None when every literal stored.

    Raises:
        ExitSignal: a readonly refusal under ``fatal``.
    """
    for name, append, items in arrays:
        if view.is_readonly(name):
            if fatal:
                err = f"bash: {name}: readonly variable\n".encode()
                raise ExitSignal(1, stderr=err, contained_code=1)
            return _readonly_refusal(cmd, name)
        note_local_array(session, name)
        try:
            await _premark(view, name, shaping)
        except PolicyDenied as exc:
            return _refusal(cmd, exc)
        base: ShellValue
        if assoc or name in session.assocs:
            built, bad_words = build_assoc_literal(session.assocs.get(name),
                                                   items, append)
            if errors is not None:
                errors.extend(f"bash: {name}: '{word}': must use subscript "
                              "when assigning associative array"
                              for word in bad_words)
            base = built
        else:
            held = session.arrays.get(name)
            if append and held is None:
                scalar = session.env.get(name)
                held = None if scalar is None else [scalar]
            base = build_indexed_literal(
                held, items, append,
                functools.partial(element_index,
                                  env=visible_env(session),
                                  elements=session_elements(session)))
        try:
            if global_scope:
                await _write_global(session, view, name, base)
            else:
                await view.set(name, base)
        except PolicyDenied as exc:
            return _refusal(cmd, exc)
        except ArithError as exc:
            return _arith_refusal(cmd, exc)
        if stored is not None:
            stored.append(name)
        if mark is not None:
            # Ungated on purpose: the `view.set` immediately above put
            # this same name through the gate, so re-asking would show a
            # policy two writes for one operand.
            set_attr(session, name, mark, on)
    return None


async def handle_declare_print(
    names: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``declare -p``: render declarations for names, or for all.

    With names, they print in the order given and a name that does not
    exist is reported on stderr without stopping the rest, exiting 1 at
    the end -- GNU prints the names it knows and refuses only the ones
    it does not. Bare ``declare -p`` lists every visible name sorted.

    Args:
        names (list[str]): the names to render, empty for all.
        session (Session): shell session state.
    """
    targets = names or sorted(session.vars)
    lines: list[str] = []
    errors: list[str] = []
    for name in targets:
        line = _declare_line(session, name)
        if line is None:
            errors.append(f"bash: declare: {name}: not found")
        else:
            lines.append(line)
    out = (("\n".join(lines) + "\n") if lines else "").encode()
    code = 1 if errors else 0
    if not errors:
        return out, IOResult(), ExecutionNode(command="declare", exit_code=0)
    err = ("\n".join(errors) + "\n").encode()
    return out, IOResult(exit_code=code,
                         stderr=err), ExecutionNode(command="declare",
                                                    exit_code=code,
                                                    stderr=err)


async def handle_export(
    assignments: list[str],
    session: Session,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Export names, or print them (``export -p`` / bare ``export``).

    With no name operands, prints every entry in ``session.env`` as
    ``declare -x NAME="value"`` (bash's ``-p`` form). Invalid option
    characters fail with status 2 and the GNU usage line. Writes go
    through the session view, so readonly refusal and the pre_session
    policy gate fire here exactly as for any other writer.
    """
    flags, names, bad = _split_decl_flags(assignments, _EXPORT_FLAGS)
    if bad is not None:
        err = (f"bash: export: -{bad}: invalid option\n"
               f"{_EXPORT_USAGE}").encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="export",
                                                         exit_code=2,
                                                         stderr=err)
    # -p with names is ignored for display; bare / -p alone print.
    if not names and not arrays:
        lines = _export_lines(session, flags)
        out = (("\n".join(lines) + "\n") if lines else "").encode()
        return out, IOResult(), ExecutionNode(command="export", exit_code=0)
    # -f is accepted and marks nothing: mirage carries no export
    # attribute on functions. -n is the off direction, and applies to
    # both spellings, since `export -n K=v` assigns and unexports.
    view = _view(session, state)
    on = "n" not in flags
    if arrays:
        # `export ARR=(a b)` marks the array as surely as it marks a
        # scalar: GNU prints `declare -ax ARR=([0]="a" [1]="b")`.
        refused = await _store_staged_arrays("export",
                                             session,
                                             view,
                                             arrays,
                                             mark=VarAttr.EXPORT,
                                             on=on,
                                             fatal=True)
        if refused is not None:
            return refused
    errors: list[str] = []
    for assign in names:
        refusal = _identifier_refusal("export", assign)
        if refusal is not None:
            errors.append(refusal)
            continue
        if "=" in assign:
            key, _, val = assign.partition("=")
            if view.is_readonly(key):
                return _readonly_refusal("export", key)
            try:
                await view.set(key, val)
            except PolicyDenied as exc:
                return _refusal("export", exc)
            set_attr(session, key, VarAttr.EXPORT, on)
        else:
            # The bare form writes no value, so it marks through the
            # plane's no-value door rather than inventing an empty
            # string. On a name that does not exist yet that leaves it
            # *unset and exported*, which is bash's own third state --
            # `export Z` prints `declare -x Z` and stays out of `env`
            # until something gives it a value. Still gated: marking a
            # hidden or policy-refused name is a session write.
            try:
                await view.mark(assign, VarAttr.EXPORT, on)
            except PolicyDenied as exc:
                return _refusal("export", exc)
    if errors:
        return _identifier_failure("export", errors)
    return None, IOResult(), ExecutionNode(command="export", exit_code=0)


def handle_declare_functions(
    cmd: str,
    session: Session,
    flags: set[str],
    names: list[str],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the function half of ``declare``: ``-f`` / ``-F`` / ``-rf``.

    ``-F NAME`` prints the name; ``-f NAME`` prints ``declare -f NAME``
    where GNU prints the reformatted body (mirage carries no
    pretty-printer, so the name row is the deliberate stand-in, the
    same shape ``-F`` and ``readonly -f`` list in). A missing name is
    exit 1 with no message. With ``-r`` the named functions freeze, as
    ``readonly -f`` does. With no names, ``-F`` lists every function
    and ``-f`` lists them the same way.

    Args:
        cmd (str): the builtin's own name for a diagnostic.
        session (Session): shell session state.
        flags (set[str]): the declaration's collected flag letters.
        names (list[str]): the function names, empty to list all.
    """
    if "r" in flags:
        return _readonly_functions(session, names)
    targets = names or sorted(session.functions)
    lines: list[str] = []
    missing = False
    for name in targets:
        if name not in session.functions:
            missing = True
            continue
        if "F" in flags:
            lines.append(name if names else f"declare -f {name}")
        else:
            lines.append(f"declare -f {name}")
    out = (("\n".join(lines) + "\n") if lines else "").encode()
    code = 1 if missing else 0
    return out, IOResult(exit_code=code), ExecutionNode(command=cmd,
                                                        exit_code=code)


def _readonly_functions(
        session: Session,
        names: list[str]) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``readonly -f``: freeze the named functions, or list the frozen.

    Args:
        session (Session): shell session state.
        names (list[str]): the function names, empty to list.
    """
    if not names:
        lines = [
            f"declare -fr {name}"
            for name in sorted(session.readonly_functions)
            if name in session.functions
        ]
        out = (("\n".join(lines) + "\n") if lines else "").encode()
        return out, IOResult(), ExecutionNode(command="readonly", exit_code=0)
    errors: list[str] = []
    for name in names:
        if name not in session.functions:
            errors.append(f"bash: readonly: {name}: not a function")
            continue
        session.readonly_functions.add(name)
    if errors:
        err = ("\n".join(errors) + "\n").encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="readonly",
                                                         exit_code=1,
                                                         stderr=err)
    return None, IOResult(), ExecutionNode(command="readonly", exit_code=0)


async def handle_readonly(
    assignments: list[str],
    session: Session,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
    stored: list[str] | None = None,
    assoc: bool = False,
    shaping: frozenset[VarAttr] = frozenset(),
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Mark names readonly, or print them (``readonly -p`` / bare form).

    With no name operands, prints every readonly name as ``declare -r``
    (or ``declare -ar`` for arrays). Invalid options fail with status 2.

    ``-f`` freezes *functions*: a frozen one refuses redefinition and
    ``unset -f`` with its own message, exit 1, and the old body stays.
    A name that is not a function is ``not a function``, exit 1, and
    the other operands still freeze. With no names, ``-f`` lists the
    frozen functions as ``declare -fr NAME``; GNU prints each body first
    through its own pretty-printer, which mirage does not carry, so the
    body line is the one deliberate omission.
    """
    flags, names, bad = _split_decl_flags(assignments, _READONLY_FLAGS)
    if bad is not None:
        err = (f"bash: readonly: -{bad}: invalid option\n"
               f"{_READONLY_USAGE}").encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="readonly",
                                                         exit_code=2,
                                                         stderr=err)
    if "f" in flags:
        return _readonly_functions(session, names)
    if not names and not arrays:
        lines = _readonly_lines(session, flags)
        out = (("\n".join(lines) + "\n") if lines else "").encode()
        return out, IOResult(), ExecutionNode(command="readonly", exit_code=0)
    view = _view(session, state)
    errors: list[str] = []
    if arrays:
        refused = await _store_staged_arrays("readonly",
                                             session,
                                             view,
                                             arrays,
                                             mark=VarAttr.READONLY,
                                             fatal=True,
                                             stored=stored,
                                             assoc=assoc or "A" in flags,
                                             errors=errors,
                                             shaping=shaping)
        if refused is not None:
            return refused
    for assign in names:
        refusal = _identifier_refusal("readonly", assign)
        if refusal is not None:
            errors.append(refusal)
            continue
        if "=" in assign:
            key, _, val = assign.partition("=")
            if view.is_readonly(key):
                return _readonly_refusal("readonly", key)
            try:
                await _premark(view, key, shaping)
                await view.set(key, val)
            except PolicyDenied as exc:
                return _refusal("readonly", exc)
            except ArithError as exc:
                return _arith_refusal("readonly", exc)
            # Ungated: the `view.set` above already put this name
            # through the gate, so the mark rides on that decision.
            set_attr(session, key, VarAttr.READONLY)
            if stored is not None:
                stored.append(key)
        else:
            # Gated, exactly as `export NAME` is. The bare form writes no
            # value, so it has no `view.set` to ride on, and marking
            # through `set_attr` walked straight past `pre_session`: a
            # deployment refusing `AWS_*` still saw `readonly AWS_KEY`
            # exit 0, create the record, and freeze the name against
            # every later legitimate write.
            try:
                await view.mark(assign, VarAttr.READONLY, True)
            except PolicyDenied as exc:
                return _refusal("readonly", exc)
            if stored is not None:
                stored.append(assign)
    if errors:
        return _identifier_failure("readonly", errors)
    return None, IOResult(), ExecutionNode(command="readonly", exit_code=0)


def _unset_variable(session: Session, name: str) -> None:
    """Clear what the env door does not own after a whole-variable unset.

    The scalar half is the view's (``unset`` popped it, or quietly kept
    it for a hidden name — a direct pop here would undo that refusal);
    this clears the array storage and the getopts residue. The array
    pop keeps a hidden name too: the embedder can seed
    ``session.arrays`` before narrowing, so a hidden array exists and
    is as much the host's to keep as the scalar the view protected.

    Args:
        session (Session): shell session state.
        name (str): a bare variable name (no subscript).
    """
    if not var_hidden(session.hidden_vars, name):
        session.vars.pop(name, None)
    if name == "OPTIND":
        session._getopts_optind = None


async def _unset_element(session: Session, view: SessionView, base: str,
                         subscript: str) -> str:
    """Clear one array element, or a scalar addressed as ``base[0]``.

    Clearing an element keeps the indices of the elements after it, as
    bash does: it leaves a hole, which neither expands in ``${arr[@]}``
    nor counts toward ``${#arr[@]}`` but keeps ``${arr[i]}`` addressing
    the same values. A subscript on a scalar names element 0 only:
    ``x[0]`` unsets the scalar and any other subscript is an error. A
    subscript on a name that holds nothing at all is a silent no-op,
    but on an existing array a negative subscript still below zero
    after the extent is added is a bad-subscript error.

    The element mechanics are the builtin's own, but the landing write
    goes through the door: a scalar's element 0 is the whole unset,
    and an array's hole punch is computed on a copy and stored with
    ``view.set``, so a denial leaves the array untouched. Validation
    errors write nothing and so never ask.

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        base (str): the variable name without the subscript.
        subscript (str): the subscript text between the brackets.

    Returns:
        str: ``"ok"``, ``"notarray"`` when a non-zero subscript was
            applied to a scalar, or ``"subscript"`` for a negative
            subscript outside an existing array.

    Raises:
        PolicyDenied: a pre_session policy refused the write.
    """
    amap = visible_assocs(session).get(base)
    if amap is not None:
        # The subscript is the key, verbatim: `unset "m[1+1]"` removes
        # the key "1+1", and a key that is not there (GNU pins
        # `unset "m[@]"` on an associative array as this same no-op)
        # answers quietly without a write.
        if subscript not in amap:
            return "ok"
        new_map = dict(amap)
        new_map.pop(subscript)
        await view.set(base, new_map)
        return "ok"
    arr = visible_arrays(session).get(base)
    if arr is None:
        # Visible reads on purpose: a hidden base answers the unset
        # branch's silent no-op instead of a denial that would leak
        # the name's existence.
        if env_get(session, base) is None:
            return "ok"
        if _array_index(subscript, visible_env(session)) != 0:
            return "notarray"
        await view.unset(base)
        return "ok"
    idx = _array_index(subscript, visible_env(session))
    if idx < 0:
        idx += array_extent(arr)
        if idx < 0:
            return "subscript"
    new_arr = list(arr)
    array_unset(new_arr, idx)
    await view.set(base, new_arr)
    return "ok"


async def handle_unset(
    args: list[str],
    session: Session,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Unset shell variables, arrays, or functions, with bash's flags.

    ``-v`` targets a variable only, ``-f`` a function only, and a bare
    name a variable if one exists or else a function. A ``name[idx]``
    operand clears one element; the readonly guard resolves it to the
    base name first, since that is what ``readonly`` records. ``-n``
    unsets a name reference itself, where a bare name unsets what the
    reference points at.

    Args:
        args (list[str]): option words followed by names to unset.
        session (Session): shell session state.
    """
    mode = "auto"
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if all(ch in "vfn" for ch in tok[1:]):
            if "f" in tok[1:]:
                mode = "f"
            elif "n" in tok[1:]:
                mode = "n"
            else:
                mode = "v"
            i += 1
            continue
        err = f"bash: unset: {tok}: invalid option\n".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="unset",
                                                         exit_code=2,
                                                         stderr=err)
    for name in args[i:]:
        if mode == "n":
            # `unset -n` drops the reference itself rather than what it
            # points at; on a name that is not a reference bash unsets
            # the variable, and both are one ungated-by-target unset.
            try:
                await _view(session, state).unset(name, follow_ref=False)
            except PolicyDenied as exc:
                return _refusal("unset", exc)
            continue
        if mode == "f":
            if name in session.readonly_functions:
                err = (f"bash: unset: {name}: cannot unset: "
                       "readonly function\n").encode()
                return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                    command="unset", exit_code=1, stderr=err)
            session.functions.pop(name, None)
            continue
        target = _PRINTF_TARGET_RE.match(name)
        subscript = target.group(2) if target is not None else None
        is_element = subscript is not None
        # `readonly arr` records the base name, so an `arr[i]` operand has
        # to be resolved before the guard, as bash does (which also names
        # the base, not the element, in the error).
        base = target.group(1) if target is not None else name
        if base in session.readonly_vars:
            err = (f"bash: unset: {base}: cannot unset: "
                   f"readonly variable\n").encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="unset",
                                                             exit_code=1,
                                                             stderr=err)
        existed = (is_element or name in session.env or name in session.arrays
                   or name in session.assocs)
        # Both spellings clear the pre_session gate for the base name:
        # the whole-variable unset through the view's env half, an
        # element unset inside _unset_element, so `unset 'X[0]'` cannot
        # sidestep a policy that vetoes `unset X`.
        try:
            if subscript is not None:
                status = await _unset_element(session, _view(session, state),
                                              base, subscript)
            else:
                await _view(session, state).unset(name)
                _unset_variable(session, deref(session, name))
                status = "ok"
        except PolicyDenied as exc:
            return _refusal("unset", exc)
        if status != "ok":
            # bash names the base for "not an array variable" but prints
            # only the bracketed part for a bad subscript.
            detail = (f"unset: {base}: not an array variable"
                      if status == "notarray" else
                      f"unset: {name[len(base):]}: bad array subscript")
            err = f"bash: {detail}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="unset",
                                                             exit_code=1,
                                                             stderr=err)
        if mode == "auto" and not existed and name in session.functions:
            if name in session.readonly_functions:
                err = (f"bash: unset: {name}: cannot unset: "
                       "readonly function\n").encode()
                return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                    command="unset", exit_code=1, stderr=err)
            session.functions.pop(name, None)
    return None, IOResult(), ExecutionNode(command="unset", exit_code=0)


def note_local_array(session: Session, name: str) -> bool:
    """Record the caller's array before a function shadows ``name``.

    ``local -a`` / ``declare -a`` inside a function shadow the caller's
    array, so the old value (or its absence) has to be remembered for the
    teardown in ``execute_command``.

    Args:
        session (Session): shell session state.
        name (str): the array name being declared.

    Returns:
        bool: True when a function scope is active, so the caller should
            shadow rather than reuse whatever is already there.
    """
    local_vars = session._local_vars
    if local_vars is None:
        return False
    if name not in local_vars:
        local_vars[name] = session.vars.get(name)
    return True


def _nameref_refusal(cmd: str, name: str, target: str) -> str | None:
    """The line `declare -n NAME=TARGET` earns when TARGET is unusable.

    bash refuses a target that is not a variable name (`invalid variable
    name for name reference`) and a reference to itself (`nameref
    variable self references not allowed`). A target spelled as an
    array element (`a[1]`) is a name bash accepts and mirage does not:
    the reference resolver maps names to names, so it is refused in
    mirage's own voice rather than stored and half-honored.

    Args:
        cmd (str): the builtin's spelling, for the diagnostic.
        name (str): the reference being declared.
        target (str): the value it was given.
    """
    if _SUBSCRIPT_RE.fullmatch(target) is not None:
        return (f"mirage: {cmd}: {target}: name reference to an array "
                "element is not supported")
    if not _is_valid_name(target):
        return (f"bash: {cmd}: `{target}': invalid variable name for name "
                "reference")
    if target == name:
        return (f"bash: {cmd}: {name}: nameref variable self references "
                "not allowed")
    return None


async def _write_global(
    session: Session,
    view: SessionView,
    key: str,
    value: ShellValue,
) -> None:
    """Store a `declare -g` value on the global record.

    Outside a function, or for a name no function on the call path has
    shadowed, that is an ordinary write. Otherwise the running locals
    live in `session.vars` and the global record is what the
    *outermost* shadowing frame saved, so the write goes through the
    door with the two swapped for its duration: the gate sees an
    ordinary write, and the local comes back untouched, which is what
    GNU shows (`local G=5; declare -g G=1` leaves `$G` at 5 in the
    function and 1 outside, and a nested `declare -g` reaches past the
    caller's local too).

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        key (str): the variable.
        value (ShellValue): the value.
    """
    outer = next((frame for frame in session._local_frames if key in frame),
                 None)
    if outer is None:
        await view.set(key, value)
        return
    shadowing = session.vars.get(key)
    saved = outer[key]
    if saved is None:
        session.vars.pop(key, None)
    else:
        session.vars[key] = saved
    try:
        await view.set(key, value)
        outer[key] = session.vars.get(key)
    finally:
        if shadowing is None:
            session.vars.pop(key, None)
        else:
            session.vars[key] = shadowing


async def handle_local(
    assignments: list[str],
    session: Session,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
    cmd: str = "local",
    stored: list[str] | None = None,
    assoc: bool = False,
    shaping: frozenset[VarAttr] = frozenset(),
    nameref: bool = False,
    global_scope: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Declare names in the running function's scope, or globally.

    Args:
        assignments (list[str]): ``NAME`` / ``NAME=value`` operands.
        session (Session): shell session state.
        state (SessionView | None): the session plane's gated door.
        arrays (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the declaration.
        cmd (str): the spelling that reached here, for diagnostics.
            ``declare`` and ``typeset`` route through this handler and
            must say their own name, not ``local``.
        stored (list[str] | None): filled with each name that stored.
        assoc (bool): the declaration carried ``-A``, so staged
            literals build associative maps.
        shaping (frozenset[VarAttr]): the value-shaping attributes
            (``-i -l -u``) the declaration carries. They are marked on
            each name *before* its value stores, after the local
            snapshot, so the declaration's own value coerces exactly as
            a later write would: GNU stores ``7`` for
            ``declare -i n=3+4`` and ``hello`` for ``declare -l s=HeLLo``.
        nameref (bool): the declaration carried ``-n``, so a value names
            the reference's target and is stored on the reference's own
            record rather than written through an existing one.
        global_scope (bool): the declaration carried ``-g``, so inside a
            function the names are declared globally: no local snapshot
            is taken, and a name the function already shadows has its
            *global* record written.
    """
    local_vars = None if global_scope else session._local_vars
    if cmd == "local" and session._local_vars is None:
        # `local` is the one spelling that needs a function scope;
        # `declare`/`typeset` share this handler and are legal at top
        # level. Without the check the builtin took its operands, stored
        # them globally and exited 0, which is the silent-accept this
        # whole tier exists to remove.
        err = b"bash: local: can only be used in a function\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd,
                                                         exit_code=1,
                                                         stderr=err)
    view = _view(session, state)
    errors: list[str] = []
    if arrays:
        refused = await _store_staged_arrays(cmd,
                                             session,
                                             view,
                                             arrays,
                                             fatal=session._local_vars is None,
                                             stored=stored,
                                             assoc=assoc,
                                             errors=errors,
                                             shaping=shaping,
                                             global_scope=global_scope)
        if refused is not None:
            return refused
    for assign in assignments:
        refusal = _identifier_refusal(cmd, assign)
        if refusal is not None:
            errors.append(refusal)
            continue
        if "=" in assign:
            key, _, val = assign.partition("=")
            if nameref:
                refusal = _nameref_refusal(cmd, key, val)
                if refusal is not None:
                    errors.append(refusal)
                    continue
            if view.is_readonly(key):
                return _readonly_refusal(cmd, key)
            if local_vars is not None and key not in local_vars:
                local_vars[key] = session.vars.get(key)
            try:
                await _premark(view, key, shaping)
                if global_scope:
                    await _write_global(session, view, key, val)
                else:
                    await view.set(key, val, follow_ref=not nameref)
            except PolicyDenied as exc:
                return _refusal(cmd, exc)
            except ArithError as exc:
                return _arith_refusal(cmd, exc)
            if stored is not None:
                stored.append(key)
        else:
            if local_vars is not None and assign not in local_vars:
                local_vars[assign] = session.vars.get(assign)
            if (env_get(session, assign) is None
                    and assign not in visible_arrays(session)
                    and assign not in visible_assocs(session)):
                # A bare declaration of an existing array re-scopes it;
                # a scalar write here would erase it. Visible reads: a
                # hidden name counts as unset, so the write is
                # attempted and the door refuses it.
                if view.is_readonly(assign):
                    return _readonly_refusal(cmd, assign)
                try:
                    # Declared, not assigned. `local L` leaves the name
                    # *unset*, exactly as `export Z` does: GNU prints
                    # `declare -- L` and `${L-d}` still expands to `d`.
                    # Writing `""` here made both wrong, which is the
                    # same invented-empty-string bug the mark door was
                    # added to fix for `export`.
                    await view.mark(assign, None, True)
                except PolicyDenied as exc:
                    return _refusal(cmd, exc)
            if stored is not None:
                stored.append(assign)
    if errors:
        return _identifier_failure(cmd, errors)
    return None, IOResult(), ExecutionNode(command=cmd, exit_code=0)


async def handle_let(
    args: list[str],
    session: Session,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Evaluate each operand as an arithmetic expression.

    ``let`` is ``(( ))`` spelled as a builtin: every word is one
    expression, the writes each one performs land through the element
    writer in order, and the exit status is 1 when the *last* expression
    evaluated to 0 (``let a=1 b=0`` exits 1, ``let b=0 a=1`` exits 0).
    No operand at all is ``let: expression expected``, exit 1, and a
    malformed one aborts the builtin at that word with the evaluator's
    own message; the operands before it have already landed, which is
    GNU's order too.

    Args:
        args (list[str]): the words after ``let``, one expression each.
        session (Session): shell session state.
        state (SessionView | None): the session plane's gated door.
    """
    if not args:
        err = b"bash: let: expression expected\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="let",
                                                         exit_code=1,
                                                         stderr=err)
    view = _view(session, state)
    value = 0
    for expr in args:
        try:
            arith = evaluate_arith(expr,
                                   visible_env(session),
                                   elements=session_elements(session))
        except ArithError as exc:
            err = f"bash: let: {expr}: {exc}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="let",
                                                             exit_code=1,
                                                             stderr=err)
        for write in arith.writes:
            try:
                ensure_var_visible(session, write.name)
            except PolicyDenied as exc:
                return _refusal("let", exc)
            if view.is_readonly(write.name):
                return _readonly_refusal("let", write.name)
        try:
            for write in arith.writes:
                await assign_element(session, view, write.name, write.key,
                                     write.value)
        except PolicyDenied as exc:
            return _refusal("let", exc)
        value = arith.value
    code = 0 if value != 0 else 1
    return None, IOResult(exit_code=code), ExecutionNode(command="let",
                                                         exit_code=code)
