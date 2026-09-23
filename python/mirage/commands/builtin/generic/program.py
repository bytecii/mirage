from mirage.commands.builtin.grep_pattern import merge_pattern_list
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.runtime.types import DispatchFn
from mirage.utils.errors import FS_ERRORS, fs_error_line

PROGRAM_FILE_COMMANDS = frozenset({"grep", "sed", "awk", "jq"})


async def prepare_program(
    name: str,
    texts: list[str],
    flags: dict[str, FlagValue],
    stdin: ByteSource | None,
    dispatch: DispatchFn,
) -> tuple[list[str], dict[str, FlagValue], ByteSource | None, IOResult
           | None]:
    """Read program files once, before input routing or traversal fan-out.

    The program belongs to the invocation, not any input mount. Lower it
    to the command's inline form so every native sub-run sees the same
    program, including when reading it consumed stdin. GNU behavior is
    pinned in integ against debian:stable-slim (grep 3.11, sed 4.9).

    Args:
        name (str): a PROGRAM_FILE_COMMANDS member.
        texts (list[str]): parsed positional text operands.
        flags (dict[str, FlagValue]): spec-bound flags with PATH values.
        stdin (ByteSource | None): the invocation's original input.
        dispatch (DispatchFn): the policy-gated workspace reader.
    """
    fl = FlagView(flags, spec=SPECS[name])
    key = "from_file" if name == "jq" else "file" if name == "grep" else "f"
    files = fl.as_paths(key)
    if not files:
        return texts, flags, stdin, None
    source = resolve_source(stdin)
    consumed = False
    pieces: list[bytes] = []
    for path in files:
        try:
            if name != "jq" and is_stdin(path):
                pieces.append(await materialize(source))
                consumed = True
            else:
                data, _ = await dispatch("read", path)
                pieces.append(await materialize(data))
        except FS_ERRORS as exc:
            # Match GNU's fatal script-open status; ordinary input-file
            # failures still belong to the native command handlers.
            line = fs_error_line(name, path, exc)
            if name == "sed":
                line = line.replace("sed: ", "sed: couldn't open file ", 1)
            return texts, flags, stdin, IOResult(
                exit_code=4 if name == "sed" else 2, stderr=line.encode())
    out = dict(flags)
    out.pop(key)
    if name == "grep":
        pattern = "\n".join(fl.as_list("e")) if fl.as_list("e") else None
        for data in pieces:
            pattern = merge_pattern_list(pattern, data)
        # An empty pattern-file list preserves grep's zero-pattern sentinel.
        out["file"] = []
        out["e"] = [] if pattern is None else [pattern]
    elif name == "sed":
        out["e"] = [
            *fl.as_list("e"),
            *(data.decode(errors="replace").removesuffix("\n")
              for data in pieces)
        ]
    else:
        texts = [
            "\n".join(data.decode(errors="replace") for data in pieces), *texts
        ]
    return texts, out, source if consumed else stdin, None
