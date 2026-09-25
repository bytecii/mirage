import zlib
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.compress import gzip_decompress_stream
from mirage.utils.key_prefix import mounted_path


async def gunzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    keep: bool = False,
    force: bool = False,
    to_stdout: bool = False,
    test_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        source = resolve_source(stdin,
                                "gunzip: (stdin): unexpected end of file")
        return gzip_decompress_stream(source), IOResult()

    if test_only:
        for p in paths:
            raw = await read_bytes(p)
            zlib.decompress(raw, zlib.MAX_WBITS | 16)
        return None, IOResult()

    if to_stdout:
        chunks: list[bytes] = []
        for p in paths:
            raw = await read_bytes(p)
            chunks.append(zlib.decompress(raw, zlib.MAX_WBITS | 16))
        return b"".join(chunks), IOResult()

    writes: dict[str, ByteSource] = {}
    for p in paths:
        raw = await read_bytes(p)
        stripped = p.mount_path
        out_path = stripped.removesuffix(".gz") if stripped.endswith(
            ".gz") else stripped + ".out"
        out_data = zlib.decompress(raw, zlib.MAX_WBITS | 16)
        await write_bytes(mounted_path(p, out_path), out_data)
        writes[out_path] = out_data
        if not keep:
            await unlink(p)
    return None, IOResult(writes=writes)


__all__ = ["gunzip"]


@dataclass(frozen=True, slots=True)
class GunzipFlags:
    keep: bool = False
    force: bool = False
    to_stdout: bool = False
    test_only: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> GunzipFlags:
    fl = FlagView(flags, spec=SPECS["gunzip"])
    return GunzipFlags(
        keep=fl.as_bool("k"),
        force=fl.as_bool("f"),
        to_stdout=fl.as_bool("c"),
        test_only=fl.as_bool("t"),
    )


def gunzip_writes(flags: Mapping[str, FlagValue],
                  paths: list[PathSpec]) -> bool:
    """Whether a gunzip invocation writes: each operand is replaced by
    its content unless ``-c`` sends it to stdout or ``-t`` only tests it,
    and with no operand gunzip filters stdin to stdout.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flag bag.
        paths (list[PathSpec]): the operands the mount received.
    """
    parsed = parse_flags(flags)
    return bool(paths) and not (parsed.to_stdout or parsed.test_only)


async def gunzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await gunzip(paths,
                        read_bytes=read_bytes,
                        write_bytes=write_bytes,
                        unlink=unlink,
                        stdin=opts.stdin,
                        keep=parsed.keep,
                        force=parsed.force,
                        to_stdout=parsed.to_stdout,
                        test_only=parsed.test_only)
