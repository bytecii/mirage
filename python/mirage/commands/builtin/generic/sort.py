from collections.abc import Awaitable, Callable

from mirage.commands.builtin.sort_helper import (SortKeyError, build_config,
                                                 sort_lines)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def sort(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    reverse: bool = False,
    numeric: bool = False,
    unique: bool = False,
    fold_case: bool = False,
    key_defs: list[str] | None = None,
    field_separator: str | None = None,
    human_numeric: bool = False,
    version_sort: bool = False,
    month_sort: bool = False,
    ignore_blanks: bool = False,
    stable: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    try:
        cfg = build_config(
            key_defs=key_defs or [],
            field_sep=field_separator,
            reverse=reverse,
            numeric=numeric,
            unique=unique,
            fold_case=fold_case,
            human_numeric=human_numeric,
            version_sort=version_sort,
            month_sort=month_sort,
            ignore_blanks=ignore_blanks,
            stable=stable,
        )
    except SortKeyError as exc:
        return b"", IOResult(stderr=f"sort: {exc}\n".encode(), exit_code=2)

    if paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            all_lines.extend(split_lines(data))
    else:
        raw = await _read_stdin_async(stdin)
        all_lines = split_lines((raw or b"").decode(errors="replace"))

    all_lines = sort_lines(all_lines, cfg)
    output = "\n".join(all_lines)
    return (output + "\n").encode() if all_lines else b"", IOResult()


__all__ = ["sort"]
