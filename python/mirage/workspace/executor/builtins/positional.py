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
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import SET_OPTION_DEFAULTS, SET_OPTION_NAMES
from mirage.shell.options import parse_option_word
from mirage.workspace.executor.builtins.variable_utils import (_is_shift_count,
                                                               _is_valid_name,
                                                               _view)
from mirage.workspace.session import Session
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.state import visible_env
from mirage.workspace.types import ExecutionNode


async def handle_shift(
    args: list[str],
    call_stack: CallStack | None,
    session: Session | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Shift positional parameters, with bash's argument checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the shift count.
        call_stack (CallStack | None): function-call positional frames.
        session (Session | None): shell session state.
    """
    if len(args) > 1:
        err = b"shift: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    if args and not _is_shift_count(args[0]):
        err = f"shift: {args[0]}: numeric argument required\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    n = int(args[0]) if args else 1
    shifted = False
    if call_stack is not None and call_stack.get_all_positional():
        call_stack.shift(n)
        shifted = True
    if not shifted and session is not None:
        pos = getattr(session, "positional_args", None)
        if pos is not None:
            session.positional_args = pos[n:]
    return None, IOResult(), ExecutionNode(command="shift", exit_code=0)


async def handle_set(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        lines = [f"{k}={v}" for k, v in visible_env(session).items()]
        out = ("\n".join(sorted(lines)) + "\n").encode()
        return out, IOResult(), ExecutionNode(command="set", exit_code=0)
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            session.positional_args = args[i + 1:]
            return None, IOResult(), ExecutionNode(command="set", exit_code=0)
        # `-o` and `+o` with nothing after them print the option table
        # instead of setting anything, in two different spellings: `-o`
        # as a padded name/value column, `+o` as lines that can be fed
        # back to `set`. Both are checked before the option grammar,
        # since a bare `-o` is not a setting.
        if tok in ("-o", "+o") and i + 1 >= len(args):
            out = _option_listing(session, plus=tok == "+o")
            return out, IOResult(), ExecutionNode(command="set", exit_code=0)
        word = parse_option_word(tok,
                                 args[i + 1] if i + 1 < len(args) else None)
        if word is None:
            session.positional_args = args[i:]
            break
        for option, enable in word.settings:
            # `-o` takes a name rather than a letter, and a name bash does
            # not have is the one thing it refuses: exit 2, and the
            # settings already applied stay applied while the rest of the
            # line is dropped. Without this a typo -- or an option mirage
            # has yet to wire, as `physical` once was -- reads as success.
            if option not in SET_OPTION_NAMES:
                err = f"set: {option}: invalid option name\n".encode()
                return None, IOResult(exit_code=2,
                                      stderr=err), ExecutionNode(command="set",
                                                                 exit_code=2,
                                                                 stderr=err)
            session.shell_options[option] = enable
        # A letter naming no option is ignored rather than refused: bash
        # has options mirage does not implement (`-a`, `-B`, `-H`), and
        # `set` is where a script turns those on without wanting to fail.
        # A nested shell answers the same leftovers differently, which is
        # why the grammar hands them back instead of deciding here.
        i += word.consumed
    return None, IOResult(), ExecutionNode(command="set", exit_code=0)


def _option_listing(session: Session, plus: bool) -> bytes:
    """Render `set -o` or `set +o` with no name after it.

    GNU 5.2.37 prints every option it knows, alphabetically, whether or
    not the shell has been told anything about it: `-o` as a name padded
    to 15 columns, a tab, then `on`/`off`, and `+o` as `set -o NAME` /
    `set +o NAME` lines a script can source back. `interactive-comments`
    is longer than the padding and simply overflows it, which is GNU's
    own `%-15s\\t%s` and not a special case.

    Args:
        session (Session): the session holding the shell options.
        plus (bool): render the `set +o` re-readable spelling.
    """
    lines = []
    for name, default in SET_OPTION_DEFAULTS.items():
        on = session.shell_options.get(name, default)
        if plus:
            lines.append(f"set {'-' if on else '+'}o {name}")
        else:
            lines.append(f"{name:<15}\t{'on' if on else 'off'}")
    return ("\n".join(lines) + "\n").encode()


async def _getopts_finish(
    session: Session,
    view: SessionView,
    name: str,
    opt_value: str,
    optarg: str | None,
    new_optind: int,
    new_pos: int,
    exit_code: int,
    stderr: bytes = b"",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # The name is assigned last, exactly as bash does: OPTIND/OPTARG and
    # the hidden cursor still advance, but a bad destination fails the
    # write and turns the call into a status-1 error. Writes go through
    # the session view, so a pre_session policy or a readonly OPTARG /
    # OPTIND refuses here too.
    try:
        if not _is_valid_name(name):
            stderr = (f"bash: getopts: `{name}': "
                      f"not a valid identifier\n").encode()
            exit_code = 1
        elif name in session.readonly_vars:
            stderr = f"bash: {name}: readonly variable\n".encode()
            exit_code = 1
        else:
            await view.set(name, opt_value)
        if optarg is None:
            await view.unset("OPTARG")
        else:
            await view.set("OPTARG", optarg)
        await view.set("OPTIND", str(new_optind))
    except ReadonlyVariableError as exc:
        stderr = f"bash: {exc.name}: readonly variable\n".encode()
        exit_code = 1
    except PolicyDenied as exc:
        stderr = f"{exc.strerror}\n".encode()
        exit_code = 1
    session._getopts_pos = new_pos
    session._getopts_optind = new_optind
    io = IOResult(exit_code=exit_code, stderr=stderr)
    return None, io, ExecutionNode(command="getopts",
                                   exit_code=exit_code,
                                   stderr=stderr)


async def handle_getopts(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Parse one option per call, with bash's getopts semantics.

    Args:
        args (list[str]): words after `getopts`: the optstring, the name
            variable, then optional explicit arguments (the positional
            parameters are scanned when no explicit ones are given).
        session (Session): shell session; OPTIND/OPTARG live in its env
            and the hidden per-word scan offset in its getopts state.
        call_stack (CallStack | None): function-call positional frames;
            inside a shell function getopts scans the function's own
            positional parameters, matching bash.
    """
    if len(args) < 2:
        err = b"getopts: usage: getopts optstring name [arg]\n"
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="getopts",
                                                         exit_code=2,
                                                         stderr=err)
    view = _view(session, state)
    optstring = args[0]
    name = args[1]
    if len(args) > 2:
        params = args[2:]
    elif call_stack is not None and call_stack.get_all_positional():
        params = call_stack.get_all_positional()
    else:
        params = session.positional_args
    silent = optstring.startswith(":")
    verbose = not silent and session.env.get("OPTERR", "1") != "0"
    try:
        optind = int(session.env.get("OPTIND", "1"))
    except ValueError:
        optind = 1
    # Bash treats a nonpositive OPTIND as a restart at argument 1.
    restart = optind < 1
    if restart:
        optind = 1
    if restart or session._getopts_optind != optind:
        session._getopts_pos = 0
    pos = session._getopts_pos

    if optind > len(params):
        return await _getopts_finish(session, view, name, "?", None, optind, 0,
                                     1)
    word = params[optind - 1]
    # A stale cursor left past the end of the current word (a shorter or
    # reused argument) restarts the scan rather than indexing out of range.
    if pos >= len(word):
        pos = 0
    if pos == 0:
        if not word.startswith("-") or word == "-":
            return await _getopts_finish(session, view, name, "?", None,
                                         optind, 0, 1)
        if word == "--":
            return await _getopts_finish(session, view, name, "?", None,
                                         optind + 1, 0, 1)
        pos = 1

    letter = word[pos]
    rest = word[pos + 1:]
    idx = optstring.find(letter)
    is_valid = letter != ":" and idx != -1
    takes_arg = (is_valid and idx + 1 < len(optstring)
                 and optstring[idx + 1] == ":")

    if not is_valid:
        if rest:
            after_optind, after_pos = optind, pos + 1
        else:
            after_optind, after_pos = optind + 1, 0
        if silent:
            return await _getopts_finish(session, view, name, "?", letter,
                                         after_optind, after_pos, 0)
        err = (f"bash: illegal option -- {letter}\n".encode()
               if verbose else b"")
        return await _getopts_finish(session, view, name, "?", None,
                                     after_optind, after_pos, 0, err)

    if not takes_arg:
        if rest:
            after_optind, after_pos = optind, pos + 1
        else:
            after_optind, after_pos = optind + 1, 0
        return await _getopts_finish(session, view, name, letter, None,
                                     after_optind, after_pos, 0)

    if rest:
        return await _getopts_finish(session, view, name, letter, rest,
                                     optind + 1, 0, 0)
    if optind < len(params):
        return await _getopts_finish(session, view, name, letter,
                                     params[optind], optind + 2, 0, 0)
    if silent:
        return await _getopts_finish(session, view, name, ":", letter,
                                     optind + 1, 0, 0)
    err = (f"bash: option requires an argument -- {letter}\n".encode()
           if verbose else b"")
    return await _getopts_finish(session, view, name, "?", None, optind + 1, 0,
                                 0, err)
