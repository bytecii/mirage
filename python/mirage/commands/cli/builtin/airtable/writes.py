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
from collections.abc import AsyncIterator, Callable
from typing import Any

from mirage.accessor.airtable import AirtableAccessor
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.core.airtable.client import (create_comment, create_records,
                                         delete_records, list_tables,
                                         update_records)
from mirage.core.airtable.config import AirtableConfig
from mirage.core.airtable.normalize import (deletions_jsonl, normalize_comment,
                                            records_jsonl, to_json_bytes)
from mirage.core.render.json import compact_json_text
from mirage.io.stream import yield_bytes
from mirage.io.types import IOResult

from mirage.commands.cli.builtin.airtable.util import (  # isort: skip
    Outcome, json_object, no_operands, one_operand, optional_operand,
    parse_json, run, scoped_base, stdin_text, usage_error)

LINE_KEYS = frozenset({"record_id", "created_time", "fields"})

# The field types Airtable computes and refuses a write to. A mount line
# carries every one of them, so a line piped back drops them first.
COMPUTED_TYPES = frozenset({
    "aiText",
    "autoNumber",
    "button",
    "count",
    "createdBy",
    "createdTime",
    "externalSyncSource",
    "formula",
    "lastModifiedBy",
    "lastModifiedTime",
    "lookup",
    "multipleLookupValues",
    "rollup",
})

Rows = list[dict[str, Any]]


def record_lines(prog: str, text: str, *, need_id: bool,
                 need_fields: bool) -> Rows:
    """Stdin's JSONL, one normalized record per line, validated whole.

    A line is the shape records.jsonl holds, so a mount read piped
    through jq round-trips. Every line is checked before anything is
    sent: a bad line 15 must not leave ten records already written. A
    blank line is skipped but still counted, so a refusal names the
    line an editor shows.

    Args:
        prog (str): the verb's display path.
        text (str): stdin as text.
        need_id (bool): each line must carry ``record_id``.
        need_fields (bool): each line must carry ``fields``.
    """
    rows: Rows = []
    for number, line in enumerate(text.split("\n"), start=1):
        if not line.strip(" \t\r"):
            continue
        where = f"stdin line {number}"
        try:
            row = parse_json(line)
        except ValueError as exc:
            raise usage_error(prog, f"{where}: not valid JSON") from exc
        if not isinstance(row, dict):
            raise usage_error(prog, f"{where}: not a JSON object")
        unknown = sorted(set(row) - LINE_KEYS)
        if unknown:
            raise usage_error(
                prog, f"{where}: unknown key {compact_json_text(unknown[0])}")
        if "fields" in row and not isinstance(row["fields"], dict):
            raise usage_error(prog, f'{where}: "fields" must be an object')
        if need_id and "record_id" not in row:
            raise usage_error(prog, f'{where}: "record_id" is required')
        if need_id and not isinstance(row["record_id"], str):
            raise usage_error(prog, f'{where}: "record_id" must be a string')
        if need_fields and "fields" not in row:
            raise usage_error(prog, f'{where}: "fields" is required')
        rows.append(row)
    return rows


async def writable(accessor: AirtableAccessor, base_id: str, table: str,
                   cells: Rows) -> Rows:
    """The cells with every computed field of the table taken out.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table (str): the table, by id or by name.
        cells (Rows): each record's cell map, keyed by field name.
    """
    tables = await list_tables(accessor, base_id)
    found = (next((t for t in tables if t.get("id") == table), None) or next(
        (t for t in tables if t.get("name") == table), None))
    computed = {
        f.get("name")
        for f in (found or {}).get("fields") or []
        if f.get("type") in COMPUTED_TYPES
    }
    return [{k: v for k, v in c.items() if k not in computed} for c in cells]


async def landed(prog: str, batches: AsyncIterator[Rows],
                 render: Callable[[Rows], bytes]) -> Outcome:
    """Everything the batches wrote, and the failure that stopped them.

    Batches land one request at a time, so a failure part way leaves
    the earlier ones written. They are printed anyway, with the error on
    stderr and exit 1, so the line shows what reached the base. A
    failure before anything landed raises, for the executor to render
    in the same ``<prog>: <error>`` shape.

    Args:
        prog (str): the verb's display path, for the stderr line.
        batches (AsyncIterator[Rows]): the write, one batch per request.
        render (Callable[[Rows], bytes]): how the written rows print.
    """
    done: Rows = []
    try:
        async for batch in batches:
            done.extend(batch)
    except Exception as exc:
        if not done:
            raise
        return yield_bytes(render(done)), IOResult(
            exit_code=1, stderr=f"{prog}: {exc}\n".encode())
    return yield_bytes(render(done)), IOResult()


async def _record_create(accessor: AirtableAccessor,
                         inv: CLIInvocation[AirtableConfig], fl: FlagView,
                         prog: str) -> Outcome:
    no_operands(prog, inv.texts)
    fields = fl.as_str("fields")
    table = fl.as_str("table") or ""
    rows: Rows | None = None
    if fields is not None:
        cells = [json_object(prog, "--fields", fields)]
    elif inv.stdin is not None:
        rows = record_lines(prog,
                            await stdin_text(inv.stdin),
                            need_id=False,
                            need_fields=True)
        cells = [row["fields"] for row in rows]
    else:
        raise usage_error(prog, "--fields or records on stdin are required")
    base_id = scoped_base(inv.config, fl.as_str("base") or "")
    if rows:
        cells = await writable(accessor, base_id, table, cells)
    batches = create_records(accessor,
                             base_id,
                             table,
                             cells,
                             typecast=fl.as_bool("typecast"))
    return await landed(prog, batches, records_jsonl)


async def _record_update(accessor: AirtableAccessor,
                         inv: CLIInvocation[AirtableConfig], fl: FlagView,
                         prog: str) -> Outcome:
    record_id = optional_operand(prog, inv.texts)
    fields = fl.as_str("fields")
    table = fl.as_str("table") or ""
    if record_id is not None and fields is None:
        raise usage_error(prog, "--fields is required with RECORD")
    if record_id is None and fields is not None:
        raise usage_error(prog, "RECORD is required with --fields")
    rows: Rows | None = None
    if record_id is not None and fields is not None:
        ids = [record_id]
        cells = [json_object(prog, "--fields", fields)]
    elif inv.stdin is not None:
        rows = record_lines(prog,
                            await stdin_text(inv.stdin),
                            need_id=True,
                            need_fields=True)
        ids = [row["record_id"] for row in rows]
        cells = [row["fields"] for row in rows]
    else:
        raise usage_error(prog,
                          "RECORD --fields or records on stdin are required")
    base_id = scoped_base(inv.config, fl.as_str("base") or "")
    if rows:
        cells = await writable(accessor, base_id, table, cells)
    batches = update_records(accessor,
                             base_id,
                             table,
                             list(zip(ids, cells)),
                             typecast=fl.as_bool("typecast"))
    return await landed(prog, batches, records_jsonl)


async def _record_delete(accessor: AirtableAccessor,
                         inv: CLIInvocation[AirtableConfig], fl: FlagView,
                         prog: str) -> Outcome:
    if inv.texts:
        record_ids = list(inv.texts)
    elif inv.stdin is not None:
        rows = record_lines(prog,
                            await stdin_text(inv.stdin),
                            need_id=True,
                            need_fields=False)
        record_ids = [row["record_id"] for row in rows]
    else:
        raise usage_error(prog, "RECORD or records on stdin are required")
    base_id = scoped_base(inv.config, fl.as_str("base") or "")
    batches = delete_records(accessor, base_id,
                             fl.as_str("table") or "", record_ids)
    return await landed(prog, batches, deletions_jsonl)


async def _comment_add(accessor: AirtableAccessor,
                       inv: CLIInvocation[AirtableConfig], fl: FlagView,
                       prog: str) -> Outcome:
    record_id = one_operand(prog, inv.texts, "RECORD")
    text = fl.as_str("text")
    if text is None:
        if inv.stdin is None:
            raise usage_error(prog, "--text or text on stdin is required")
        piped = await stdin_text(inv.stdin)
        text = piped[:-1] if piped.endswith("\n") else piped
    if not text:
        raise usage_error(prog, "the comment text is empty")
    base_id = scoped_base(inv.config, fl.as_str("base") or "")
    comment = await create_comment(accessor, base_id,
                                   fl.as_str("table") or "", record_id, text)
    return yield_bytes(to_json_bytes(normalize_comment(comment))), IOResult()


record_create = functools.partial(run, "record create", _record_create)
record_update = functools.partial(run, "record update", _record_update)
record_delete = functools.partial(run, "record delete", _record_delete)
comment_add = functools.partial(run, "comment add", _comment_add)
