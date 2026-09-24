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

import json
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.accessor.airtable import AirtableAccessor
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import usage_hint
from mirage.core.airtable.config import AirtableConfig
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.utils.errors import eacces, format_fs_error

PROG = "airtable"

Outcome = tuple[ByteSource | None, IOResult]

Verb = Callable[
    [AirtableAccessor, CLIInvocation[AirtableConfig], FlagView, str],
    Awaitable[Outcome]]


def usage_error(prog: str, message: str) -> UsageError:
    """A refusal in the voice the parser refuses a bad flag in, exit 2.

    Args:
        prog (str): the verb's display path ("airtable record create").
        message (str): what is wrong with the line.
    """
    return UsageError(f"{prog}: {message}\n{usage_hint(prog)}")


def no_operands(prog: str, texts: tuple[str, ...]) -> None:
    """Refuse an operand on a verb that takes none.

    Args:
        prog (str): the verb's display path.
        texts (tuple[str, ...]): the line's operands.
    """
    if texts:
        raise usage_error(prog, f"unrecognized arguments: {' '.join(texts)}")


def one_operand(prog: str, texts: tuple[str, ...], name: str) -> str:
    """The one operand a verb requires.

    Args:
        prog (str): the verb's display path.
        texts (tuple[str, ...]): the line's operands.
        name (str): the operand's name in the verb's usage line.
    """
    if not texts:
        raise usage_error(prog,
                          f"the following arguments are required: {name}")
    no_operands(prog, texts[1:])
    return texts[0]


def optional_operand(prog: str, texts: tuple[str, ...]) -> str | None:
    """The operand a verb may take once, None when the line has none.

    Args:
        prog (str): the verb's display path.
        texts (tuple[str, ...]): the line's operands.
    """
    no_operands(prog, texts[1:])
    return texts[0] if texts else None


def scoped_base(config: AirtableConfig, base_id: str) -> str:
    """The base a line addresses, refused when ``base_ids`` excludes it.

    Refused here, before any request, so a base the install was not
    given is never reached: the scope the mount enforces on reads.

    Args:
        config (AirtableConfig): the install and its scope.
        base_id (str): the base id the line names.

    Raises:
        PermissionError: the base is outside ``base_ids`` (EACCES).
    """
    wanted = config.base_ids
    if wanted is not None and base_id not in wanted:
        raise eacces(base_id)
    return base_id


def _no_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def parse_json(text: str) -> Any:
    """Decode strict JSON: NaN and Infinity are refused, as JSON.parse does.

    Args:
        text (str): the JSON text.
    """
    return json.loads(text, parse_constant=_no_constant)


def json_object(prog: str, flag: str, text: str) -> dict[str, Any]:
    """A flag's value decoded as a JSON object.

    Args:
        prog (str): the verb's display path.
        flag (str): the flag's spelling, for the refusal.
        text (str): the value as typed.
    """
    try:
        value = parse_json(text)
    except ValueError as exc:
        raise usage_error(prog, f"{flag} must be valid JSON") from exc
    if not isinstance(value, dict):
        raise usage_error(prog, f"{flag} must be a JSON object")
    return value


async def stdin_text(stdin: ByteSource) -> str:
    """Piped input as text, a leading byte order mark dropped.

    Args:
        stdin (ByteSource): the line's stdin.
    """
    return (await materialize(stdin)).decode("utf-8-sig", errors="replace")


async def run(path: str, verb: Verb,
              inv: CLIInvocation[AirtableConfig]) -> Outcome:
    """Run one verb on its own accessor, rendering a scope refusal.

    The accessor lives for the invocation and closes with it, the way a
    one-shot ``SessionAccessor`` is used. The verb's display path
    (``airtable base get``) prefixes its refusals, as the executor
    prefixes a leaf's failure, so a base outside the install's scope
    answers ``airtable base get: <base-id>: Permission denied``, exit 1.

    Args:
        path (str): the verb's words below the head ("base get").
        verb (Verb): the verb's body, handed its display path.
        inv (CLIInvocation[AirtableConfig]): the line.
    """
    prog = f"{PROG} {path}"
    fl = FlagView(inv.flags, inv.spec)
    async with AirtableAccessor(inv.config) as accessor:
        try:
            return await verb(accessor, inv, fl, prog)
        except PermissionError as exc:
            return None, IOResult(exit_code=1,
                                  stderr=format_fs_error(prog, exc))
