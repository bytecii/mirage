import zlib
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.stream import (operand_label,
                                                  resolve_source, stdin_bytes)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import flag_kwarg_name
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.compress import gunzip_checked, gzip_compress_stream
from mirage.utils.errors import GzipDataError
from mirage.utils.key_prefix import mounted_path


def extract_level(fl: FlagView) -> int:
    """The compression level -1..-9 asked for, or zlib's default.

    The digits are short-only options, so each is its own dest -- except
    ``-1``, which the parser disambiguates to ``args_1``
    (``AMBIGUOUS_NAMES``). Reading the bag by the bare digit therefore
    missed ``gzip -1`` entirely.

    Args:
        fl (FlagView): Flag view constructed with the gzip spec.
    """
    for n in range(9, 0, -1):
        if fl.as_bool(flag_kwarg_name(str(n))):
            return n
    return zlib.Z_DEFAULT_COMPRESSION


async def gzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    decompress: bool = False,
    keep: bool = False,
    force: bool = False,
    to_stdout: bool = False,
    level: int = zlib.Z_DEFAULT_COMPRESSION,
) -> tuple[ByteSource | None, IOResult]:
    if not paths and not decompress:
        return gzip_compress_stream(resolve_source(stdin),
                                    level=level), IOResult()
    read = stdin_bytes(read_bytes, stdin)
    writes: dict[str, ByteSource] = {}
    stdout: list[bytes] = []
    errors: list[str] = []
    # With no operand gzip -d reads stdin. A `-` has no file to replace, so
    # it goes to stdout; gzip refuses to follow /dev/stdin in place, so
    # only `-` does this. An input with no gzip header is reported and
    # skipped; a truncated or corrupt one ends the run.
    for p in paths or [STDIN_OPERAND]:
        in_place = not (to_stdout or p.raw_path == "-")
        raw = await (read_bytes(p) if in_place else read(p))
        if decompress:
            try:
                data = gunzip_checked(raw)
            except GzipDataError as exc:
                errors.append(f"gzip: {operand_label(p, 'stdin')}: {exc}\n")
                if exc.fatal:
                    break
                continue
        else:
            data = zlib.compress(raw, level=level, wbits=zlib.MAX_WBITS | 16)
        if not in_place:
            stdout.append(data)
            continue
        stripped = p.mount_path
        if decompress:
            out_path = stripped.removesuffix(".gz") if stripped.endswith(
                ".gz") else stripped + ".out"
        else:
            out_path = stripped + ".gz"
        await write_bytes(mounted_path(p, out_path), data)
        writes[out_path] = data
        if not keep:
            await unlink(p)
    return b"".join(stdout) or None, IOResult(writes=writes,
                                              exit_code=1 if errors else 0,
                                              stderr="".join(errors).encode()
                                              or None)


__all__ = ["gzip", "extract_level"]


@dataclass(frozen=True, slots=True)
class GzipFlags:
    decompress: bool = False
    keep: bool = False
    force: bool = False
    to_stdout: bool = False
    level: int | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> GzipFlags:
    fl = FlagView(flags, spec=SPECS["gzip"])
    return GzipFlags(
        decompress=fl.as_bool("d"),
        keep=fl.as_bool("k"),
        force=fl.as_bool("f"),
        to_stdout=fl.as_bool("c"),
        level=extract_level(fl),
    )


def gzip_writes(flags: Mapping[str, FlagValue], paths: list[PathSpec]) -> bool:
    """Whether a gzip invocation writes: each file operand is replaced by
    its archive unless ``-c`` sends the result to stdout, while a ``-``
    operand, like no operand, filters stdin to stdout.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flag bag.
        paths (list[PathSpec]): the operands the mount received.
    """
    replaces = any(p.raw_path != "-" for p in paths)
    return replaces and not parse_flags(flags).to_stdout


async def gzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await gzip(paths,
                      read_bytes=read_bytes,
                      write_bytes=write_bytes,
                      unlink=unlink,
                      stdin=opts.stdin,
                      decompress=parsed.decompress,
                      keep=parsed.keep,
                      force=parsed.force,
                      to_stdout=parsed.to_stdout,
                      level=(parsed.level if parsed.level is not None else
                             zlib.Z_DEFAULT_COMPRESSION))
