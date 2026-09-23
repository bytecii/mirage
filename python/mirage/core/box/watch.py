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
from collections.abc import AsyncIterator, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import (absent_on_404, events_now, events_since,
                                 list_folder_items)
from mirage.core.box.client import BoxTokenManager
from mirage.core.box.constants import (EVENT_REPLAY_DAYS, EVENT_STREAM,
                                       PLACE_EVENTS, TRASH_EVENTS)
from mirage.core.box.resolve import (mount_relative_key, path_parts,
                                     resolve_item, root_id)
from mirage.types import (Delta, FileChangeKind, FileEvent, FileMetadata,
                          JsonValue, PathSpec, WalkEntry)
from mirage.watch.base import DeltaHook
from mirage.watch.constants import DIR_FINGERPRINT
from mirage.watch.delta import spec_for
from mirage.watch.events import event_at, field, virtual_of
from mirage.watch.fingerprint import stat_fingerprint

_NATIVE = 1


def _entry(virtual: str, item: dict[str, Any]) -> WalkEntry:
    """One walk row for a Box item, fingerprinted the way stat does.

    The fingerprint matches what ``ReaddirWalk`` built from Box stat, so a
    listing-era checkpoint upgrades without reporting every file.
    """
    if item.get("type") == "folder":
        return WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
    modified = item.get("modified_at") or None
    size = item.get("size")
    size = size if isinstance(size, int) else None
    return WalkEntry(virtual=virtual,
                     is_dir=False,
                     fingerprint=stat_fingerprint(
                         item.get("sha1") or modified, modified, size),
                     size=size,
                     modified=modified)


async def _walk(tm: BoxTokenManager, folder_id: str,
                virtual: str) -> AsyncIterator[tuple[str, WalkEntry]]:
    """Yield (box id, entry) for everything under one folder.

    Web links are skipped, as readdir hides them. A folder removed
    mid-walk is skipped; the next pull settles it.
    """
    try:
        items = await absent_on_404(virtual,
                                    lambda: list_folder_items(tm, folder_id))
    except FileNotFoundError:
        return
    for item in items:
        if item.get("type") not in ("file", "folder"):
            continue
        child = f"{virtual.rstrip('/')}/{item['name']}"
        yield str(item["id"]), _entry(child, item)
        if item.get("type") == "folder":
            async for pair in _walk(tm, str(item["id"]), child):
                yield pair


class _Tree:
    """The last applied snapshot, plus the Box id behind each path.

    Events name items by id, and a move or trash event does not carry
    where the item was, so the id map is what finds the old path.
    """

    def __init__(self, snapshot: dict[str, str], ids: dict[str, str]) -> None:
        self.snapshot = dict(snapshot)
        self.ids = dict(ids)
        self.entries: dict[str, WalkEntry] = {}

    def put(self, box_id: str, entry: WalkEntry) -> None:
        self.snapshot[entry.virtual] = (DIR_FINGERPRINT if entry.is_dir else
                                        entry.fingerprint or "")
        self.ids[box_id] = entry.virtual
        self.entries[entry.virtual] = entry

    def drop(self, virtual: str) -> None:
        under = virtual + "/"
        for key in list(self.snapshot):
            if key == virtual or key.startswith(under):
                del self.snapshot[key]
        for box_id, key in list(self.ids.items()):
            if key == virtual or key.startswith(under):
                del self.ids[box_id]

    def move(self, old: str, new: str) -> None:
        under = old + "/"

        def rebase(key: str) -> str:
            if key == old or key.startswith(under):
                return new + key[len(old):]
            return key

        self.snapshot = {rebase(k): v for k, v in self.snapshot.items()}
        self.ids = {i: rebase(k) for i, k in self.ids.items()}


def _encode(position: str, observed: datetime, tree: _Tree) -> str:
    return json.dumps(
        {
            "_box": _NATIVE,
            "p": position,
            "t": observed.isoformat(),
            "s": tree.snapshot,
            "i": tree.ids,
        },
        sort_keys=True)


def _decode(
    checkpoint: str | None
) -> tuple[str | None, datetime | None, dict[str, str] | None, dict[str, str],
           bool]:
    """Return (position, pulled at, snapshot, ids, native).

    A listing-era checkpoint is a bare ``{virtual: fingerprint}`` map
    with no stream position; it is diffed against a fresh walk once and
    upgraded.
    """
    if checkpoint is None:
        return None, None, None, {}, False
    data = json.loads(checkpoint)
    if not isinstance(data, dict):
        return None, None, None, {}, False
    if data.get("_box") == _NATIVE:
        return (data["p"], datetime.fromisoformat(data["t"]), data["s"],
                data["i"], True)
    return None, None, data, {}, False


def _diff(root: PathSpec, previous: dict[str, str], tree: _Tree,
          observed: datetime) -> tuple[FileEvent, ...]:
    changes: list[FileEvent] = []
    for virtual in sorted(tree.snapshot.keys() | previous.keys()):
        old = previous.get(virtual)
        new = tree.snapshot.get(virtual)
        if old == new:
            continue
        if old is None:
            kind = FileChangeKind.CREATE
        elif new is None:
            kind = FileChangeKind.DELETE
        else:
            kind = FileChangeKind.UPDATE
        entry = tree.entries.get(virtual)
        metadata = None
        if (entry is not None and not entry.is_dir
                and kind is not FileChangeKind.DELETE):
            metadata = FileMetadata(fingerprint=entry.fingerprint,
                                    size=entry.size,
                                    modified=entry.modified)
        changes.append(
            FileEvent(kind=kind,
                      path=spec_for(root, virtual),
                      timestamp=observed,
                      metadata=metadata))
    return tuple(changes)


def _source(event: JsonValue) -> dict[str, Any] | None:
    """The file or folder an event is about, or None.

    User events carry the full item as ``source``, with the
    ``path_collection`` that places it. Web links, users and
    collaborations are not paths on the mount.
    """
    source = field(event, "source")
    if not isinstance(source, dict) or source.get("type") not in ("file",
                                                                  "folder"):
        return None
    if not source.get("id"):
        return None
    return source


class BoxDeltaHook:
    """Box ``/events`` pull, with the per-folder walk as reset.

    The user event stream is account-wide, so every event is placed
    through its ``path_collection`` and dropped unless it lands under
    the watch root. A move arrives as one ``ITEM_MOVE`` (or
    ``ITEM_RENAME``) naming only the new location, which is why the
    checkpoint keeps the Box id of each path next to the snapshot: the
    id finds the old path, and a moved folder carries its subtree with
    it. A folder that shows up already populated (a copy, a restore, a
    move in from outside the root) is walked, since Box sends one event
    for the folder and none for what is inside.

    Box never refuses an old ``stream_position``: user events are kept
    for two weeks to two months and a stale position replays whatever
    is left. So there is no error to reset on, and a checkpoint older
    than ``EVENT_REPLAY_DAYS`` relists instead. The relist reads the
    stream head before walking, so a write that lands mid-walk is
    replayed by the next pull rather than lost; the fingerprint diff
    discards the repeat.
    """

    def __init__(self, accessor: BoxAccessor) -> None:
        """Args:
            accessor (BoxAccessor): Backend handle.
        """
        self._accessor = accessor

    def _virtual(self, root: PathSpec, item: dict[str, Any]) -> str | None:
        relative = mount_relative_key(item, root_id(self._accessor))
        if relative is None:
            return None
        virtual = virtual_of(root, relative)
        if not virtual.startswith(root.virtual.rstrip("/") + "/"):
            return None
        return virtual

    async def _root_folder(self, root: PathSpec) -> str | None:
        parts = path_parts(root)
        if not parts:
            return root_id(self._accessor)
        try:
            item = await absent_on_404(
                root.virtual, lambda: resolve_item(self._accessor, parts))
        except FileNotFoundError:
            return None
        if item is None or item.get("type") != "folder":
            return None
        return str(item["id"])

    async def _relist(self, root: PathSpec, previous: dict[str, str] | None,
                      observed: datetime) -> Delta:
        tm = self._accessor.token_manager
        position = await events_now(tm, EVENT_STREAM)
        tree = _Tree({}, {})
        folder = await self._root_folder(root)
        if folder is not None:
            async for box_id, entry in _walk(tm, folder, root.virtual):
                tree.put(box_id, entry)
        changes = () if previous is None else _diff(root, previous, tree,
                                                    observed)
        return Delta(changes=changes,
                     checkpoint=_encode(position, observed, tree))

    async def _apply(self, root: PathSpec, tree: _Tree,
                     event: dict[str, Any]) -> None:
        source = _source(event)
        if source is None:
            return
        box_id = str(source["id"])
        kind = event.get("event_type")
        old = tree.ids.get(box_id)
        if kind in TRASH_EVENTS:
            if old is not None:
                tree.drop(old)
            return
        if kind not in PLACE_EVENTS:
            return
        virtual = self._virtual(root, source)
        is_dir = source.get("type") == "folder"
        if old is not None and old != virtual:
            if virtual is not None and is_dir:
                tree.move(old, virtual)
                return
            tree.drop(old)
        if virtual is None:
            return
        if is_dir:
            if old is None:
                tree.put(box_id, _entry(virtual, source))
                async for pair in _walk(self._accessor.token_manager, box_id,
                                        virtual):
                    tree.put(*pair)
            return
        tree.put(box_id, _entry(virtual, source))

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Pull changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): Native event-stream checkpoint, a
                listing JSON snapshot, or None for a baseline.
        """
        position, pulled, previous, ids, native = _decode(checkpoint)
        observed = datetime.now(timezone.utc)
        if (not native or position is None or pulled is None
                or observed - pulled > timedelta(days=EVENT_REPLAY_DAYS)):
            return await self._relist(root, previous, observed)
        found, position = await events_since(self._accessor.token_manager,
                                             position, EVENT_STREAM)
        tree = _Tree(previous or {}, ids)
        seen: set[str] = set()
        for event in found:
            # Box may send an event more than once; the id says so.
            event_id = event.get("event_id")
            if event_id:
                if event_id in seen:
                    continue
                seen.add(event_id)
            await self._apply(root, tree, event)
        return Delta(changes=_diff(root, previous or {}, tree, observed),
                     checkpoint=_encode(position, observed, tree))


class BoxEventHook:
    """Map one Box user event onto mount paths.

    The consumer owns the long poll: ``realtime_server`` gives the URL,
    a ``new_change`` answer means read ``events_since`` from the last
    position, and each event read goes through ``to_events`` with its
    ``event_type``. Nothing here runs a loop.

    An event names the item's new place only. A trash or a move needs
    the old one, so the hook remembers where each Box id it has mapped
    was. An id it has never seen gets the honest answer instead: a move
    or rename of an unknown item is UNKNOWN on the directory it landed
    in, and a trash of one is dropped, since nothing this hook mapped
    is stale. The pull (``BoxDeltaHook``) is the truth path for both.

    Upload of a new version and of a new file are the same
    ``ITEM_UPLOAD``, so the split between CREATE and UPDATE is also
    whether the id was seen before.
    """

    def __init__(self, accessor: BoxAccessor) -> None:
        """Args:
            accessor (BoxAccessor): Backend handle, read for its root
                folder.
        """
        self._accessor = accessor
        self._paths: dict[str, str] = {}

    async def to_events(self, root: PathSpec, event_type: str,
                        payload: JsonValue) -> Sequence[FileEvent]:
        """Map one Box event to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The event's ``event_type``.
            payload (JsonValue): The event object from ``/events``.
        """
        source = _source(payload)
        if source is None:
            return ()
        box_id = str(source["id"])
        old = self._paths.get(box_id)
        if event_type in TRASH_EVENTS:
            self._paths.pop(box_id, None)
            if old is None:
                return ()
            return (event_at(root, old, FileChangeKind.DELETE), )
        if event_type not in PLACE_EVENTS:
            return ()
        relative = mount_relative_key(source, root_id(self._accessor))
        if relative is None:
            self._paths.pop(box_id, None)
            if old is None:
                return ()
            return (event_at(root, old, FileChangeKind.DELETE), )
        self._paths[box_id] = relative
        if old is not None and old != relative:
            return (event_at(root, relative, FileChangeKind.MOVE,
                             previous=old), )
        if old is None and event_type in ("ITEM_MOVE", "ITEM_RENAME"):
            parent = relative.rsplit("/", 1)[0] if "/" in relative else ""
            return (event_at(root, parent, FileChangeKind.UNKNOWN), )
        if old is not None or event_type == "ITEM_MAKE_CURRENT_VERSION":
            return (event_at(root, relative, FileChangeKind.UPDATE), )
        return (event_at(root, relative, FileChangeKind.CREATE), )


def build_delta_hook(accessor: BoxAccessor) -> DeltaHook:
    """Build the Box delta hook.

    Args:
        accessor (BoxAccessor): Backend handle.
    """
    return BoxDeltaHook(accessor)
