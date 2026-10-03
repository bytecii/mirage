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
from mirage.shell.variable import attr_letters
from mirage.utils.hidden import var_hidden
from mirage.workspace.executor.builtins.constants import (_ANSI_C_ESCAPES,
                                                          _BARE_KEY_RE,
                                                          _SUBSCRIPT_RE)
from mirage.workspace.executor.builtins.variable_utils import _is_valid_name
from mirage.workspace.session import Session
from mirage.workspace.session.state import (env_is_readonly, exported_names,
                                            visible_env)
from mirage.workspace.types import ExecutionNode


def _is_control(ch: str) -> bool:
    return ord(ch) < 0x20 or ord(ch) == 0x7F


def _bash_declare_quote(value: str) -> str:
    """Quote a value the way bash ``declare -p`` / ``export -p`` does.

    A value holding any control character takes the ``$'...'`` form, with
    the named escapes bash uses (``\\a \\b \\t \\n \\v \\f \\r``, and
    ``\\E`` for escape) and three-digit octal for the rest; ``"``, ``$``
    and backtick need no escaping there because ``$'...'`` does not
    expand. Everything else is double-quoted with escapes for ``\\``,
    ``"``, ``$`` and backtick. Non-ASCII printable text stays literal,
    which is what bash emits in a UTF-8 locale.

    Args:
        value (str): the variable value to serialize.

    Returns:
        str: the quoted value, ready to follow ``declare -x NAME=``.
    """
    parts: list[str] = []
    if any(_is_control(ch) for ch in value):
        for ch in value:
            escape = _ANSI_C_ESCAPES.get(ch)
            if escape is not None:
                parts.append(escape)
            elif _is_control(ch):
                parts.append(f"\\{ord(ch):03o}")
            else:
                parts.append(ch)
        return "$'" + "".join(parts) + "'"
    for ch in value:
        if ch in '\\"$`':
            parts.append("\\" + ch)
        else:
            parts.append(ch)
    return '"' + "".join(parts) + '"'


def _split_decl_flags(
    args: list[str],
    allowed: frozenset[str],
) -> tuple[set[str], list[str], str | None]:
    """Split leading ``-xyz`` flag clusters from declaration operands.

    Returns:
        ``(flags, operands, bad)`` where ``bad`` is the first illegal
        option character, or ``None`` when every flag is allowed.
    """
    flags: set[str] = set()
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if tok.startswith("-") and len(tok) > 1 and tok != "-":
            body = tok[1:]
            illegal = next((c for c in body if c not in allowed), None)
            if illegal is not None:
                return flags, args[i:], illegal
            flags.update(body)
            i += 1
            continue
        break
    return flags, args[i:], None


def _export_lines(session: Session, flags: set[str]) -> list[str]:
    """Build sorted declaration lines for every exported name.

    The exported set, not every shell variable: ``X=hello`` is absent
    and ``export Y=world`` is present, which is what bash prints. ``-f``
    selects shell functions instead of variables; mirage tracks no
    export attribute on functions, so that form lists nothing, as bash
    does with none exported.

    Rendering is ``_declare_line``'s, not a second spelling of it: GNU's
    ``export -p`` prints the *whole* cluster, so a readonly exported
    scalar is ``declare -rx R="1"`` and an exported array is
    ``declare -ax AR=([0]="a")``. Writing ``declare -x`` here by hand
    printed neither, and rendered an exported array as a bare
    ``declare -x AR`` because it looked the value up among the scalars.

    Args:
        session (Session): shell session state.
        flags (set[str]): option letters the caller supplied.

    Returns:
        list[str]: one declaration line per exported name.
    """
    if "f" in flags:
        return []
    lines = [_declare_line(session, name) for name in exported_names(session)]
    return [line for line in lines if line is not None]


def _readonly_lines(session: Session, flags: set[str]) -> list[str]:
    """Build sorted ``declare -r`` family readonly lines.

    ``-a`` narrows the listing to indexed arrays and ``-A`` to
    associative ones, the way bash does. ``-f`` selects functions,
    which mirage carries no readonly attribute for, so that form lists
    nothing. Bare and ``-p`` list every readonly name.

    Args:
        session (Session): shell session state.
        flags (set[str]): option letters the caller supplied.

    Returns:
        list[str]: one declaration line per selected name.
    """
    if "f" in flags:
        return []
    arrays_only = "a" in flags
    assocs_only = "A" in flags
    env = visible_env(session)
    lines: list[str] = []
    # env_is_readonly answers False for a hidden name, so a hidden
    # readonly never prints even its bare `declare -r NAME` row.
    for name in sorted(n for n in session.readonly_vars
                       if env_is_readonly(session, n)):
        arr = session.arrays.get(name)
        amap = session.assocs.get(name)
        if arr is not None and not assocs_only:
            parts = [
                f"[{i}]={_bash_declare_quote(v)}" for i, v in enumerate(arr)
                if v is not None
            ]
            lines.append(f"declare -ar {name}=({' '.join(parts)})")
            continue
        if amap is not None and not arrays_only:
            lines.append(f"declare -Ar {name}{_assoc_body(amap)}")
            continue
        if arrays_only or assocs_only or arr is not None or amap is not None:
            continue
        if name in env:
            lines.append(f"declare -r {name}={_bash_declare_quote(env[name])}")
        else:
            lines.append(f"declare -r {name}")
    return lines


def _identifier_refusal(cmd: str, word: str) -> str | None:
    """GNU's ``not a valid identifier`` line for one declaration operand.

    A declaration builtin refuses a name it cannot declare rather than
    storing it: ``export 1BAD=x`` used to land a variable that ``$1BAD``
    can never name back (bash reads that as ``$1`` then ``BAD``) and
    then shipped it to every child environment.

    Which text GNU quotes depends on why the word failed, and both
    spellings are pinned. A word that is not a valid assignment at all
    is echoed whole (``export: `1BAD=x'``); a word whose target parses
    but is not a plain name -- an array element -- is echoed as just
    that target (``export: `arr[0]'``), since the value it would have
    taken is not what is wrong with it.

    Args:
        cmd (str): the builtin's name, for the diagnostic.
        word (str): the operand as typed, ``NAME`` or ``NAME=value``.

    Returns:
        str | None: the refusal line, or None when the name is legal.
    """
    name = word.partition("=")[0]
    if _is_valid_name(name):
        return None
    subscript = _SUBSCRIPT_RE.fullmatch(name)
    quoted = name if subscript else word
    return f"bash: {cmd}: `{quoted}': not a valid identifier"


def _identifier_failure(
        cmd: str, errors: list[str]
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Render the refusals collected while declaring names.

    One line per bad operand, exit 1, and the good operands on the same
    line are already stored: GNU reports each and keeps going, so
    ``export GOOD=1 1BAD=x GOOD2=2`` exports both good names.

    Args:
        cmd (str): builtin name for the node.
        errors (list[str]): the refusal lines, in operand order.
    """
    err = ("\n".join(errors) + "\n").encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


def _assoc_key_text(key: str) -> str:
    """One associative key as ``declare -p`` spells it.

    Bare when every character is one GNU leaves unquoted (pinned by a
    character sweep on 5.2.37: alphanumerics and the punctuation
    ``_ % + , - . / : = @ ~``), quoted like a value otherwise. A key
    that *is* ``@`` or ``*`` quotes even though the character is bare
    mid-key, since the bare spelling would read back as a splat.

    Args:
        key (str): the key to render.
    """
    if key not in ("@", "*") and _BARE_KEY_RE.fullmatch(key):
        return key
    return _bash_declare_quote(key)


def _assoc_body(amap: dict[str, str]) -> str:
    """The ``=(...)`` tail of an associative ``declare`` line.

    Sorted keys (mirage's pinned order, where GNU prints hash order)
    and GNU's trailing space before the closing paren, which an empty
    map does not carry: ``m=([a]="1" )`` but ``m=()``.

    Args:
        amap (dict[str, str]): the associative array.
    """
    if not amap:
        return "=()"
    parts = " ".join(f"[{_assoc_key_text(k)}]={_bash_declare_quote(amap[k])}"
                     for k in sorted(amap))
    return f"=({parts} )"


def _declare_line(session: Session, name: str) -> str | None:
    """The ``declare -p`` line for one name, or None when it has none.

    The attribute cluster is `attr_letters`, which is why this renders
    `declare -rx` and `declare -ar` without a table of its own: the
    record already knows its own letters and their print order. bash
    spells an empty cluster ``--``, and that spelling is the caller's
    because only a `declare` line needs it.

    A hidden name answers None, the same way `env_is_readonly` answers
    False for one: reporting it as declared would leak it.

    Args:
        session (Session): shell session state.
        name (str): the variable to render.

    Returns:
        str | None: the rendered line, or None when unset and
        unattributed, hidden, or absent.
    """
    if var_hidden(session.hidden_vars, name):
        return None
    var = session.vars.get(name)
    if var is None:
        return None
    letters = attr_letters(var)
    head = f"declare -{letters}" if letters else "declare --"
    if var.value is None:
        return f"{head} {name}"
    if isinstance(var.value, list):
        parts = [
            f"[{i}]={_bash_declare_quote(v)}" for i, v in enumerate(var.value)
            if v is not None
        ]
        return f"{head} {name}=({' '.join(parts)})"
    if isinstance(var.value, dict):
        return f"{head} {name}{_assoc_body(var.value)}"
    return f"{head} {name}={_bash_declare_quote(var.value)}"
