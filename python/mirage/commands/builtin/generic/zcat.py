from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    split_readable_coded)
from mirage.commands.builtin.utils.stream import (operand_label,
                                                  read_stdin_async, stdin_stat,
                                                  stdin_stream)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.compress import gunzip_checked
from mirage.utils.errors import GzipDataError


async def zcat(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    # Each operand decompresses independently and the outputs concatenate
    # in operand order, like GNU zcat. An input with no gzip header is
    # reported and skipped; a truncated or corrupt one ends the run.
    parts: list[bytes] = []
    errors: list[str] = []
    for p in paths or [STDIN_OPERAND]:
        raw = (await read_bytes(p)
               if paths else await read_stdin_async(stdin) or b"")
        try:
            parts.append(gunzip_checked(raw))
        except GzipDataError as exc:
            errors.append(f"zcat: {operand_label(p, 'stdin')}: {exc}\n")
            if exc.fatal:
                break
    return b"".join(parts), IOResult(exit_code=1 if errors else 0,
                                     stderr="".join(errors).encode() or None)


async def zcat_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run zcat over resolved operands; mirrors zcatGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by zcat.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    # zcat is gzip's front end, so its exit code is gzip's: a directory
    # is a warning (2) and a missing file is an error (1), which no other
    # member of this family distinguishes. Hence the coded split.
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, opts.stdin)
    readable, err, code = await split_readable_coded(paths, stat, "zcat")
    if err and not readable:
        return None, IOResult(exit_code=code, stderr=err)
    out, io = await zcat(readable,
                         read_bytes=materialized_read(stream),
                         stdin=opts.stdin)
    # A bad archive is gzip's error (1), which outranks a directory's
    # warning (2).
    return await merge_split_errors((out, io), err, io.exit_code or code)


__all__ = ["zcat", "zcat_generic"]
