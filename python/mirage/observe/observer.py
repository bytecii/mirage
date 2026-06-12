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

import json
import time

from mirage.io.types import IOResult
from mirage.observe.log_entry import (EVENT_CLEAR, EVENT_COMMAND, EVENT_DELETE,
                                      LogEntry)
from mirage.observe.record import OpRecord
from mirage.observe.store import ObserverStore, RAMObserverStore
from mirage.utils.dates import utc_date_folder


def _parse_files(files: dict[str, bytes]) -> list[dict]:
    out: list[dict] = []
    for key in sorted(files.keys()):
        if not key.endswith(".jsonl"):
            continue
        for line in files[key].decode().splitlines():
            if line:
                out.append(json.loads(line))
    return out


def _now_ms() -> int:
    return int(time.time() * 1000)


class Observer:
    """Persists LogEntry records to an ObserverStore as JSONL files.

    The hidden recorder: it owns no mount and its store is reachable
    only through this class, so the log is invisible to agents. Views
    (/.bash_history, the history builtin) render from the query
    methods below; swapping infra (RAM, Redis, disk, opfs) means
    passing a different store, nothing above this seam changes.

    Args:
        store (ObserverStore | None): Storage backend for log files;
            defaults to an in-memory RAMObserverStore.
    """

    def __init__(self, store: ObserverStore | None = None) -> None:
        self._store = store if store is not None else RAMObserverStore()
        self._seq = 0

    @property
    def store(self) -> ObserverStore:
        return self._store

    async def _log(self, entry: LogEntry) -> None:
        entry.seq = self._seq
        self._seq += 1
        line = (entry.to_json_line() + "\n").encode()
        await self._store.append(f"/{utc_date_folder()}/{entry.session}.jsonl",
                                 line)

    async def log_op(
        self,
        rec: OpRecord,
        agent: str,
        session: str,
        cwd: str | None = None,
    ) -> None:
        """Persist an OpRecord as a JSONL line.

        Args:
            rec (OpRecord): The operation record.
            agent (str): Agent ID.
            session (str): Session ID.
            cwd (str | None): Session cwd at log time.
        """
        await self._log(LogEntry.from_op_record(rec, agent, session, cwd))

    async def log_command(self, rec, cwd: str | None = None) -> None:
        """Persist an ExecutionRecord as a JSONL line.

        Args:
            rec (ExecutionRecord): The execution record.
            cwd (str | None): Session cwd at log time.
        """
        await self._log(LogEntry.from_execution_record(rec, cwd))

    async def log_execution(
        self,
        command: str,
        io: IOResult,
        op_records: list[OpRecord],
        agent: str,
        session: str,
        cwd: str | None = None,
    ) -> None:
        """Record one finished typed line: its ops, then its command.

        The line reader's single recording call: every op the line
        emitted lands first, then the command entry itself.

        Args:
            command (str): The typed line, verbatim and unexpanded.
            io (IOResult): Final result of the line.
            op_records (list[OpRecord]): Ops collected while it ran.
            agent (str): Agent that issued the line.
            session (str): Session the line ran in.
            cwd (str | None): Session cwd at completion.
        """
        for rec in op_records:
            await self.log_op(rec, agent, session, cwd)
        stdout = await io.materialize_stdout()
        await self._log(
            LogEntry(
                type=EVENT_COMMAND,
                agent=agent,
                session=session,
                timestamp=_now_ms(),
                cwd=cwd,
                command=command,
                exit_code=io.exit_code,
                stdout=stdout.decode(errors="replace")[:4096],
            ))

    async def log_command_text(self,
                               command: str,
                               session: str,
                               agent: str = "",
                               cwd: str | None = None) -> None:
        """Append a command entry without an execution (history -s).

        Args:
            command (str): Command text to record as a single entry.
            session (str): Session ID the entry belongs to.
            agent (str): Agent ID issuing the append.
            cwd (str | None): Session cwd at append time.
        """
        await self._log(
            LogEntry(
                type=EVENT_COMMAND,
                agent=agent,
                session=session,
                timestamp=_now_ms(),
                cwd=cwd,
                command=command,
                exit_code=0,
            ))

    async def log_clear(self, session: str, agent: str = "") -> None:
        """Append a clear tombstone for a session (history -c).

        Args:
            session (str): Session ID whose history view is cleared.
            agent (str): Agent ID issuing the clear.
        """
        await self._log(
            LogEntry(
                type=EVENT_CLEAR,
                agent=agent,
                session=session,
                timestamp=_now_ms(),
            ))

    async def log_delete(self,
                         session: str,
                         offset: int,
                         agent: str = "") -> None:
        """Append a delete event for one listing entry (history -d).

        Args:
            session (str): Session ID whose entry is deleted.
            offset (int): 1-based listing position; negative counts
                back from the end at the time of the delete.
            agent (str): Agent ID issuing the delete.
        """
        await self._log(
            LogEntry(
                type=EVENT_DELETE,
                agent=agent,
                session=session,
                timestamp=_now_ms(),
                offset=offset,
            ))

    async def events(self) -> list[dict]:
        """All recorded events across sessions, in append order.

        Ordered by the monotonic per-recorder seq: a total order even
        when millisecond timestamps tie, immune to clock steps.
        load_events backfills seq, so every stored event has one.

        Returns:
            list[dict]: Parsed LogEntry dicts.
        """
        out = _parse_files(await self._store.read_all())
        out.sort(key=lambda e: e.get("seq", 0))
        return out

    async def command_events(self) -> list[dict]:
        """Command events across all sessions, in append order.

        Returns:
            list[dict]: Events with type == EVENT_COMMAND.
        """
        return [
            e for e in await self.events() if e.get("type") == EVENT_COMMAND
        ]

    async def session_command_events(self, session: str) -> list[dict]:
        """One session's visible history listing, append order.

        Projects the session's events: commands after the last clear
        tombstone, with delete events applied at the position they
        were issued (history -d renumbers subsequent entries, GNU
        behavior).

        Args:
            session (str): Session ID to project.

        Returns:
            list[dict]: Events with type == EVENT_COMMAND.
        """
        files = await self._store.read_matching(f"/{session}.jsonl")
        entries = _parse_files(files)
        entries.sort(key=lambda e: e.get("seq", 0))
        last_clear = -1
        for i, e in enumerate(entries):
            if e.get("type") == EVENT_CLEAR:
                last_clear = i
        visible: list[dict] = []
        for e in entries[last_clear + 1:]:
            kind = e.get("type")
            if kind == EVENT_COMMAND:
                visible.append(e)
            elif kind == EVENT_DELETE:
                offset = e.get("offset", 0)
                idx = offset - 1 if offset > 0 else len(visible) + offset
                if 0 <= idx < len(visible):
                    visible.pop(idx)
        return visible

    async def load_events(self, events: list[dict]) -> None:
        """Load events back into the store (snapshot restore path).

        Groups by session and rewrites each session's JSONL under
        today's date folder; original date folders are not preserved,
        which the views never depend on (they filter by the session
        field and sort by seq).

        Args:
            events (list[dict]): LogEntry dicts from StateKey.HISTORY.
        """
        day = utc_date_folder()
        by_session: dict[str, list[str]] = {}
        max_seq = self._seq - 1
        for i, e in enumerate(events):
            if e.get("seq") is None:
                e = {**e, "seq": i}
            max_seq = max(max_seq, e["seq"])
            session = e.get("session", "default")
            by_session.setdefault(session, []).append(
                json.dumps(e, separators=(",", ":")))
        self._seq = max_seq + 1
        for session, lines in by_session.items():
            await self._store.write(f"/{day}/{session}.jsonl",
                                    ("\n".join(lines) + "\n").encode())
