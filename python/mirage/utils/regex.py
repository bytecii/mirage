import re
from bisect import bisect_left
from collections import OrderedDict
from collections.abc import Callable, Iterable, Iterator

from mirage.concurrency.worker import Worker
from mirage.utils.regex_scan import Match, scan_many


class AsyncRegex:
    """Prepare bounded cached subjects off-loop, then render their matches locally."""

    def __init__(
        self,
        pattern: re.Pattern[str],
        all_matches: bool = True,
        restart: bool = False,
        worker: Worker | None = None,
    ) -> None:
        self.original = pattern
        self._all_matches = all_matches
        self._restart = restart
        self.pattern = pattern.pattern
        self.flags = pattern.flags
        self.groups = pattern.groups
        self.groupindex = pattern.groupindex
        self._owns_worker = worker is None
        self._worker = worker if worker is not None else Worker()
        self._cache: OrderedDict[str, tuple[list[Match], list[int]]] = (
            OrderedDict()
        )

    async def prepare(
        self, text: str, following: Callable[[], Iterable[str]] | None = None
    ) -> None:
        if text in self._cache:
            self._cache.move_to_end(text)
            return
        subjects = list(
            dict.fromkeys(
                (text, *(following() if following is not None else ()))
            )
        )[:32]
        missing = [
            subject for subject in subjects if subject not in self._cache
        ]
        results = await self._worker.call(
            scan_many, self.original, missing, self._all_matches, self._restart
        )
        for subject, matches in zip(missing, results):
            self._cache[subject] = (matches, [m.start() for m in matches])
        for subject in subjects:
            self._cache.move_to_end(subject)
        while len(self._cache) > 32:
            self._cache.popitem(last=False)

    def search(self, text: str, pos: int = 0) -> Match | None:
        matches, starts = self._cache[text]
        index = bisect_left(starts, pos)
        return matches[index] if index < len(matches) else None

    def finditer(self, text: str) -> Iterator[Match]:
        return iter(self._cache[text][0])

    async def close(self) -> None:
        if self._owns_worker:
            await self._worker.close()
        self._cache.clear()


Pattern = re.Pattern[str] | AsyncRegex
RegexMatch = re.Match[str] | Match


async def prepare(pattern: Pattern, text: str) -> None:
    if isinstance(pattern, AsyncRegex):
        await pattern.prepare(text)
