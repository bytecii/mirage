import re
from bisect import bisect_left
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from mirage.concurrency.worker import Worker


@dataclass(frozen=True)
class Match:
    re: re.Pattern[str]
    string: str
    spans: tuple[tuple[int, int], ...]

    def _index(self, group: int | str) -> int:
        if isinstance(group, str):
            try:
                return self.re.groupindex[group]
            except KeyError as exc:
                raise IndexError(group) from exc
        return group

    def start(self, group: int | str = 0) -> int:
        return self.spans[self._index(group)][0]

    def end(self, group: int | str = 0) -> int:
        return self.spans[self._index(group)][1]

    def group(self, group: int | str = 0) -> Any:
        start, end = self.spans[self._index(group)]
        return None if start < 0 else self.string[start:end]


def scan(
    pattern: re.Pattern[str], text: str, all_matches: bool = True
) -> list[Match]:
    """Copy native matches while the uninterruptible engine stays in a worker.

    Args:
        pattern (re.Pattern[str]): the compiled host pattern.
        text (str): one search subject.
        all_matches (bool): retain every match only when rendering needs them.
    """
    first = None if all_matches else pattern.search(text)
    matches = (
        pattern.finditer(text)
        if all_matches
        else (() if first is None else (first,))
    )
    return [
        Match(
            pattern,
            text,
            tuple(m.span(i) for i in range(pattern.groups + 1)),
        )
        for m in matches
    ]


class AsyncRegex:
    """Prepare bounded cached subjects off-loop, then render their matches locally."""

    def __init__(
        self, pattern: re.Pattern[str], all_matches: bool = True
    ) -> None:
        self.original = pattern
        self._all_matches = all_matches
        self.pattern = pattern.pattern
        self.flags = pattern.flags
        self.groups = pattern.groups
        self.groupindex = pattern.groupindex
        self._worker = Worker()
        self._cache: OrderedDict[str, tuple[list[Match], list[int]]] = (
            OrderedDict()
        )

    async def prepare(self, text: str) -> None:
        if text in self._cache:
            self._cache.move_to_end(text)
            return
        matches = await self._worker.call(
            scan, self.original, text, self._all_matches
        )
        self._cache[text] = (matches, [m.start() for m in matches])
        if len(self._cache) > 32:
            self._cache.popitem(last=False)

    def search(self, text: str, pos: int = 0) -> Match | None:
        matches, starts = self._cache[text]
        index = bisect_left(starts, pos)
        return matches[index] if index < len(matches) else None

    def finditer(self, text: str) -> Iterator[Match]:
        return iter(self._cache[text][0])

    async def close(self) -> None:
        await self._worker.close()
        self._cache.clear()


Pattern = re.Pattern[str] | AsyncRegex
RegexMatch = re.Match[str] | Match


async def prepare(pattern: Pattern, text: str) -> None:
    if isinstance(pattern, AsyncRegex):
        await pattern.prepare(text)
