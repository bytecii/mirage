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

from mirage.io.types import ByteSource, IOResult
from mirage.resource.history import HISTORY_PREFIX
from mirage.workspace.session.session import Session
from mirage.workspace.types import ExecutionNode

USAGE = ("history: usage: history [-c] [-d offset] [n] or "
         "history -awrn [filename] or history -ps arg [arg...]\n")
OPTION_CHARS = "cdanrwsp"


def _usage_error(message: str) -> tuple[None, IOResult, ExecutionNode]:
    err = (message + USAGE).encode()
    io = IOResult(exit_code=2, stderr=err)
    return None, io, ExecutionNode(command="history", exit_code=2, stderr=err)


def _parse_args(
        args: list[str]) -> tuple[dict[str, object], list[str], str | None]:
    """Parse history builtin args the way bash getopt does.

    Args:
        args (list[str]): Raw tokens after the command name.

    Returns:
        tuple[dict[str, object], list[str], str | None]: Flags dict,
        operand texts, and an error message (None when parsing
        succeeded). Any dash-leading token is option-parsed, digits
        included (`history -1` is an invalid option in bash); `--` or
        the first operand ends option parsing, so `history -s rm -rf`
        stores "rm -rf" as text.
    """
    flags: dict[str, object] = {}
    texts: list[str] = []
    options_done = False
    i = 0
    while i < len(args):
        token = args[i]
        if options_done or token == "-" or not token.startswith("-"):
            texts.append(token)
            options_done = True
        elif token == "--":
            options_done = True
        else:
            for ch in token[1:]:
                if ch not in OPTION_CHARS:
                    return {}, [], f"history: -{ch}: invalid option\n"
                flags[ch] = True
            if flags.get("d") is True:
                if i + 1 >= len(args):
                    return ({}, [],
                            "history: -d: option requires an argument\n")
                i += 1
                flags["d"] = args[i]
        i += 1
    return flags, texts, None


async def handle_history(
    registry,
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Dispatch the history shell builtin to the view mount.

    GNU lookup order: builtins resolve before mount commands, so a
    mount-local command named "history" can never shadow this one.
    The actual semantics live on the /.bash_history view resource;
    this handler only parses options and routes.

    Args:
        registry (MountRegistry): The workspace's mount registry.
        args (list[str]): Raw builtin args (flags and counts).
        session (Session): Calling session.
    """
    flags, texts, error = _parse_args(args)
    if error is not None:
        return _usage_error(error)
    try:
        mount = registry.mount_for(HISTORY_PREFIX)
    except ValueError:
        err = b"history: not enabled for this workspace\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="history",
                                                         exit_code=1,
                                                         stderr=err)
    stream, io = await mount.execute_cmd("history", [],
                                         texts,
                                         flags,
                                         cwd=session.cwd,
                                         session_id=session.session_id)
    return stream, io, ExecutionNode(command="history",
                                     exit_code=io.exit_code,
                                     stderr=io.stderr)
