import re
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.formatting import _ls_mode_string
from mirage.commands.builtin.utils.output import format_records
from mirage.core.timeutil import iso_to_epoch
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line

_FORMAT_RE = re.compile(r"%(.)", re.DOTALL)

_TYPE_LABELS = {
    FileType.DIRECTORY: "directory",
    FileType.TEXT: "regular file",
    FileType.BINARY: "regular file",
    FileType.JSON: "regular file",
    FileType.CSV: "regular file",
}

_DEFAULT_OWNER = "user"


def _type_label(s: FileStat) -> str:
    return _TYPE_LABELS.get(s.type,
                            "regular file") if s.type else "regular file"


def _effective_mode(s: FileStat) -> int:
    if s.mode is not None:
        return s.mode & 0o7777
    return 0o755 if s.type == FileType.DIRECTORY else 0o644


def _type_bits(s: FileStat) -> int:
    return 0o040000 if s.type == FileType.DIRECTORY else 0o100000


def _owner(value: int | str | None) -> str:
    return str(value) if value is not None else _DEFAULT_OWNER


def _epoch(iso: str | None) -> str:
    if not iso:
        return "0"
    try:
        return str(iso_to_epoch(iso))
    except (ValueError, TypeError):
        return "0"


def _replace_spec(spec: str, s: FileStat, name: str) -> str:
    if spec == "%":
        return "%"
    if spec == "n":
        return name
    if spec == "N":
        return f"'{name}'"
    if spec == "s":
        return str(s.size if s.size is not None else 0)
    if spec == "F":
        return _type_label(s)
    if spec == "a":
        return format(_effective_mode(s), "o")
    if spec == "A":
        return _ls_mode_string(s)
    if spec == "f":
        return format(_type_bits(s) | _effective_mode(s), "x")
    if spec in ("u", "U"):
        return _owner(s.uid)
    if spec in ("g", "G"):
        return _owner(s.gid)
    if spec == "x":
        return s.atime or s.modified or ""
    if spec == "X":
        return _epoch(s.atime or s.modified)
    if spec in ("y", "z"):
        return s.modified or ""
    if spec in ("Y", "Z"):
        return _epoch(s.modified)
    if spec == "w":
        return "-"
    if spec == "W":
        return "0"
    if spec == "B":
        return "512"
    if spec in ("r", "R", "t", "T"):
        return "0"
    return "?"


def _format_stat(fmt: str, s: FileStat, name: str) -> str:
    return _FORMAT_RE.sub(lambda m: _replace_spec(m.group(1), s, name), fmt)


async def stat(
    paths: list[PathSpec],
    *,
    stat_fn: Callable[..., Awaitable[FileStat]],
    c: str | None = None,
    f: str | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("stat: missing operand")
    fmt = c if c is not None else f
    lines: list[str] = []
    err = b""
    for p in paths:
        try:
            s = await stat_fn(p)
        except FS_ERRORS as exc:
            # GNU stat keeps reporting the remaining operands, exit 1.
            err += fs_error_line("stat", p, exc).encode()
            continue
        if fmt is not None:
            lines.append(_format_stat(fmt, s, p.raw_path))
        else:
            lines.append(f"name={s.name} size={s.size}"
                         f" modified={s.modified}"
                         f" type={s.type.value if s.type else None}")
    io = IOResult(exit_code=1 if err else 0, stderr=err or None)
    if not lines:
        return None, io
    return format_records(lines), io


__all__ = ["stat"]
