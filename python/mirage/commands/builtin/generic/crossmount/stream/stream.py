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

from mirage.commands.builtin.generic.crossmount.types import (Cmd, CrossResult,
                                                              RunSingle)
from mirage.commands.builtin.generic.sort import (SortFlags, fetch_refusal,
                                                  flag_refusal,
                                                  operand_refusal, parse_flags)
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit_line
from mirage.io import IOResult
from mirage.io.stream import async_chain, materialize
from mirage.io.types import ByteSource
from mirage.types import PathSpec


def _has_active_flags(flag_kwargs: dict[str, FlagValue]) -> bool:
    return any(v not in (None, False) for v in flag_kwargs.values())


def _respell_fetch_stderr(stderr: bytes, cmd_name: str) -> bytes:
    # The per-operand fetch is a native Cmd.CAT sub-run, so its error lines
    # carry the fetch command's prefix; respell them to the real command so
    # the cross-mount bytes match single-mount.
    fetch_prefix = Cmd.CAT.encode() + b": "
    prefix = cmd_name.encode() + b": "
    return b"\n".join(
        prefix +
        line[len(fetch_prefix):] if line.startswith(fetch_prefix) else line
        for line in stderr.split(b"\n"))


def _fetch_failures(stderr: bytes) -> list[str]:
    # A failed fetch's lines without the fetch command's prefix, which is
    # what sort's own refusal is built from.
    fetch_prefix = f"{Cmd.CAT}: "
    return [
        line[len(fetch_prefix):] if line.startswith(fetch_prefix) else line
        for line in stderr.decode(errors="replace").split("\n") if line
    ]


async def _terminated(source: ByteSource, separator: bytes) -> bytes:
    # sort ends every input's last line, where cat would run it into the
    # next input's first.
    data = await materialize(source)
    if data and not data.endswith(separator):
        data += separator
    return data


async def run_stream(cmd_name: str, scopes: list[PathSpec],
                     text_args: list[str], flag_kwargs: dict[str, FlagValue],
                     run_single: RunSingle) -> CrossResult:
    """Run a stream command (``cmd files...`` == ``cat files... | cmd``).

    Each operand's raw bytes come from a native flagless ``cat`` on its
    owning mount (which also expands the operand's glob natively); one
    native run of the real command then consumes the merged stream in its
    stdin mode, so every flag keeps its single-invocation semantics
    (continuous ``cat -n``/``nl`` numbering, one global ``sort`` order, one
    ``sed`` address space). A failed operand is skipped and reported on
    stderr, cat-style; the merged exit code is then non-zero.

    ``sort`` is the one stream command whose operands are not simply
    concatenated, so it answers in the single-mount generic's words: the
    line's own refusals before any fetch, one refusal for failed inputs
    ranked the generic's way, and every input's last line ended. Its
    ``-m`` is dropped from the run over the merged stream, which a merge
    would only echo back; sorting that stream is the merge whenever each
    input is sorted, which is what ``-m`` promises. Deliberate
    divergence: unsorted inputs to a cross-mount ``sort -m`` come out
    sorted, where GNU emits them merged but unsorted.

    Args:
        cmd_name (str): One of the STREAM_COMMANDS.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (sed script).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        run_single (RunSingle): Executor-injected single-mount runner.
    """
    sort_flags: SortFlags | None = None
    if cmd_name == Cmd.SORT:
        refusal = flag_refusal(flag_kwargs)
        if refusal is None:
            sort_flags = parse_flags(flag_kwargs)
            refusal = operand_refusal(scopes, sort_flags)
        if refusal is not None:
            return None, refusal
    merged_io = IOResult()
    sources: list[ByteSource] = []
    sort_failures: list[str] = []
    failed = False
    # The real command's code for the worst failed fetch. The fetch runs
    # as Cmd.CAT, so its own code is cat's 1 whatever went wrong; the
    # stderr is already respelled into the real command's voice and the
    # code has to follow it, or `sort a /other/missing` answers 1 while
    # `sort missing` answers 2.
    fail_code = 0
    for scope in scopes:
        out, io = await run_single(Cmd.CAT, [scope], [], {})
        if io.exit_code != 0:
            failed = True
            if io.stderr is not None:
                rendered = await materialize(io.stderr)
                if sort_flags is not None:
                    sort_failures.extend(_fetch_failures(rendered))
                    io.stderr = None
                elif cmd_name != Cmd.CAT:
                    rendered = _respell_fetch_stderr(rendered, cmd_name)
                    io.stderr = rendered
                fail_code = max(fail_code,
                                read_fail_exit_line(cmd_name, rendered))
            # The fetch ran as cat, so its exit code is cat's whatever
            # went wrong. fail_code already carries the real command's,
            # and merging cat's over it would win the `or` below.
            io.exit_code = 0
            merged_io = await merged_io.merge(io)
            continue
        merged_io = await merged_io.merge(io)
        if out is not None and sort_flags is not None:
            separator = b"\x00" if sort_flags.zero_terminated else b"\n"
            sources.append(await _terminated(out, separator))
        elif out is not None:
            sources.append(out)
    # sort aborts on any failed operand like GNU (it needs every input
    # before emitting anything), matching the single-mount builder.
    if failed and sort_flags is not None:
        merged_io.stderr = fetch_refusal(sort_failures, sort_flags)
        merged_io.exit_code = merged_io.exit_code or fail_code or 1
        return None, merged_io

    body: ByteSource = async_chain(*sources)

    if cmd_name == Cmd.CAT and not _has_active_flags(flag_kwargs):
        if failed:
            merged_io.exit_code = merged_io.exit_code or fail_code or 1
        return body, merged_io

    tail_flags = flag_kwargs
    if sort_flags is not None and sort_flags.merge:
        tail_flags = {k: v for k, v in flag_kwargs.items() if k != "merge"}
    out, io = await run_single(cmd_name, [],
                               list(text_args),
                               tail_flags,
                               stdin=body,
                               resolve_hint=scopes[0])
    merged_io = await merged_io.merge(io)
    if failed:
        merged_io.exit_code = merged_io.exit_code or fail_code or 1
    return out, merged_io
