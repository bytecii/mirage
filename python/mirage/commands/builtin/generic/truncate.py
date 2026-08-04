import re
from collections.abc import Awaitable, Callable

from mirage.commands.errors import UsageError
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec

_UNITS = {
    "K": 1024,
    "KB": 1000,
    "M": 1024**2,
    "MB": 1000**2,
    "G": 1024**3,
    "GB": 1000**3,
    "T": 1024**4,
    "TB": 1000**4,
}

# GNU rejects anything strtol would not consume whole, so `1x`, ` 5` and
# `1_0` are all `Invalid number` rather than a silently truncated read.
_DIGITS = re.compile(r"\d+")


def parse_size(value: str, current: int) -> int:
    """Resolve a GNU ``truncate -s`` spec against a file's current size.

    Args:
        value (str): the ``-s`` operand, e.g. ``10K``, ``+1M``, ``/512``.
        current (int): the file's current size in bytes.
    """
    operation = value[:1] if value[:1] in {"+", "-", "<", ">", "/", "%"
                                           } else ""
    raw = value[1:] if operation else value
    suffix = next((unit for unit in sorted(_UNITS, key=len, reverse=True)
                   if raw.endswith(unit)), "")
    digits = raw[:-len(suffix)] if suffix else raw
    if _DIGITS.fullmatch(digits) is None:
        raise UsageError(f"truncate: Invalid number: '{value}'", 1)
    number = int(digits) * _UNITS.get(suffix, 1)
    if number == 0 and operation in {"/", "%"}:
        raise UsageError("truncate: division by zero", 1)
    if operation == "+":
        return current + number
    if operation == "-":
        return max(0, current - number)
    if operation == "<":
        return min(current, number)
    if operation == ">":
        return max(current, number)
    if operation == "/":
        return current - current % number
    if operation == "%":
        return ((current + number - 1) // number) * number
    return number


async def truncate(
    paths: list[PathSpec],
    *,
    size: str,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    truncate_fn: Callable[[PathSpec, int], Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("truncate: missing file operand")
    for path in paths:
        current = (await stat(path)).size or 0
        await truncate_fn(path, parse_size(size, current))
    return None, IOResult()


__all__ = ["parse_size", "truncate"]
