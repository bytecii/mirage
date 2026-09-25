from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.stream import operand_label, stdin_bytes
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.compress import gunzip_checked
from mirage.utils.errors import GzipDataError
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
    read = stdin_bytes(read_bytes, stdin)
    writes: dict[str, ByteSource] = {}
    stdout: list[bytes] = []
    errors: list[str] = []
    # With no operand gunzip reads stdin. A `-` has no file to replace, so
    # it decompresses to stdout; gzip refuses to follow /dev/stdin in
    # place, so only `-` does this. An input with no gzip header is
    # reported and skipped; a truncated or corrupt one ends the run.
    for p in paths or [STDIN_OPERAND]:
        in_place = not (to_stdout or test_only or p.raw_path == "-")
        raw = await (read_bytes(p) if in_place else read(p))
        try:
            data = gunzip_checked(raw)
        except GzipDataError as exc:
            errors.append(f"gunzip: {operand_label(p, 'stdin')}: {exc}\n")
            if exc.fatal:
                break
            continue
        if test_only:
            continue
        if not in_place:
            stdout.append(data)
            continue
        stripped = p.mount_path
        out_path = stripped.removesuffix(".gz") if stripped.endswith(
            ".gz") else stripped + ".out"
        await write_bytes(mounted_path(p, out_path), data)
        writes[out_path] = data
        if not keep:
            await unlink(p)
    return b"".join(stdout) or None, IOResult(writes=writes,
                                              exit_code=1 if errors else 0,
                                              stderr="".join(errors).encode()
                                              or None)


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
    """Whether a gunzip invocation writes: each file operand is replaced
    by its content unless ``-c`` sends it to stdout or ``-t`` only tests
    it, while a ``-`` operand, like no operand, filters stdin to stdout.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flag bag.
        paths (list[PathSpec]): the operands the mount received.
    """
    parsed = parse_flags(flags)
    replaces = any(p.raw_path != "-" for p in paths)
    return replaces and not (parsed.to_stdout or parsed.test_only)


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
