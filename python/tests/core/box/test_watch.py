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
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from mirage.accessor.box import BoxAccessor
from mirage.core.box.client import BoxTokenManager
from mirage.core.box.config import BoxConfig
from mirage.core.box.watch import BoxDeltaHook, BoxEventHook
from mirage.types import FileChangeKind, PathSpec

ALL_FILES = {"type": "folder", "id": "0", "name": "All Files"}
TEAM = {"type": "folder", "id": "10", "name": "team"}


def _accessor(root_folder_id: str | None = None) -> BoxAccessor:
    config = BoxConfig(access_token="t", root_folder_id=root_folder_id)
    return BoxAccessor(config, BoxTokenManager(config))


def _root(vfs_path: str = "") -> PathSpec:
    virtual = "/box/" + vfs_path if vfs_path else "/box"
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=vfs_path)


def _file(box_id: str, name: str, sha1: str, *parents: dict) -> dict:
    return {
        "type": "file",
        "id": box_id,
        "name": name,
        "sha1": sha1,
        "size": 4,
        "modified_at": "2026-09-20T10:00:00-07:00",
        "path_collection": {
            "total_count": len(parents) + 1,
            "entries": [ALL_FILES, *parents],
        },
    }


def _folder(box_id: str, name: str, *parents: dict) -> dict:
    return {
        "type": "folder",
        "id": box_id,
        "name": name,
        "path_collection": {
            "total_count": len(parents) + 1,
            "entries": [ALL_FILES, *parents],
        },
    }


def _event(event_type: str, source: dict, event_id: str = "") -> dict:
    return {
        "type": "event",
        "event_id": event_id or f"{event_type}-{source['id']}",
        "event_type": event_type,
        "source": source,
    }


class FakeBox:
    """Folder listings by id plus a queue of pending user events."""

    def __init__(self, folders: dict[str, list[dict]]) -> None:
        self.folders = folders
        self.pending: list[dict] = []
        self.position = 100
        self.calls: list[str] = []

    async def list_folder_items(self, tm, folder_id: str) -> list[dict]:
        self.calls.append(f"list {folder_id}")
        return self.folders.get(folder_id, [])

    async def events_now(self, tm, stream_type: str) -> str:
        self.calls.append("now")
        return str(self.position)

    async def events_since(self, tm, position: str, stream_type: str):
        self.calls.append(f"since {position}")
        found, self.pending = self.pending, []
        self.position += len(found)
        return found, str(self.position)

    def patches(self):
        return (
            patch("mirage.core.box.watch.list_folder_items",
                  self.list_folder_items),
            patch("mirage.core.box.watch.events_now", self.events_now),
            patch("mirage.core.box.watch.events_since", self.events_since),
        )


async def _pull(fake: FakeBox, hook: BoxDeltaHook, root: PathSpec,
                checkpoint: str | None):
    a, b, c = fake.patches()
    with a, b, c:
        return await hook.pull(root, checkpoint)


def _kinds(delta) -> set[tuple[str, FileChangeKind]]:
    return {(c.path.virtual, c.kind) for c in delta.changes}


@pytest.mark.asyncio
async def test_baseline_reads_the_stream_head_before_walking() -> None:
    fake = FakeBox({"0": [_file("1", "a.txt", "s1")]})
    delta = await _pull(fake, BoxDeltaHook(_accessor()), _root(), None)
    assert delta.changes == ()
    assert fake.calls == ["now", "list 0"]
    assert json.loads(delta.checkpoint)["p"] == "100"


@pytest.mark.asyncio
async def test_idle_pull_is_one_events_read_and_no_listing() -> None:
    fake = FakeBox({"0": [_folder("10", "team"), _file("1", "a.txt", "s1")]})
    hook = BoxDeltaHook(_accessor())
    base = await _pull(fake, hook, _root(), None)
    fake.calls.clear()
    delta = await _pull(fake, hook, _root(), base.checkpoint)
    assert delta.changes == ()
    assert fake.calls == ["since 100"]


@pytest.mark.asyncio
async def test_events_classify_create_update_delete() -> None:
    fake = FakeBox({
        "0": [_file("1", "a.txt", "s1"),
              _file("2", "b.txt", "s2")],
    })
    hook = BoxDeltaHook(_accessor())
    base = await _pull(fake, hook, _root(), None)
    fake.pending = [
        _event("ITEM_UPLOAD", _file("1", "a.txt", "s1-v2")),
        _event("ITEM_UPLOAD", _file("3", "c.txt", "s3")),
        _event("ITEM_TRASH", _file("2", "b.txt", "s2")),
        _event("ITEM_PREVIEW", _file("1", "a.txt", "s1-v2")),
    ]
    delta = await _pull(fake, hook, _root(), base.checkpoint)
    assert _kinds(delta) == {
        ("/box/a.txt", FileChangeKind.UPDATE),
        ("/box/c.txt", FileChangeKind.CREATE),
        ("/box/b.txt", FileChangeKind.DELETE),
    }
    created = next(c for c in delta.changes if c.path.virtual == "/box/c.txt")
    assert created.metadata.fingerprint == "s3|4"
    assert json.loads(delta.checkpoint)["p"] == "104"


@pytest.mark.asyncio
async def test_same_bytes_uploaded_again_is_no_change() -> None:
    fake = FakeBox({"0": [_file("1", "a.txt", "s1")]})
    hook = BoxDeltaHook(_accessor())
    base = await _pull(fake, hook, _root(), None)
    fake.pending = [_event("ITEM_UPLOAD", _file("1", "a.txt", "s1"))]
    delta = await _pull(fake, hook, _root(), base.checkpoint)
    assert delta.changes == ()


@pytest.mark.asyncio
async def test_folder_rename_carries_its_subtree() -> None:
    fake = FakeBox({
        "0": [_folder("10", "team")],
        "10": [_file("1", "a.txt", "s1", TEAM)],
    })
    hook = BoxDeltaHook(_accessor())
    base = await _pull(fake, hook, _root(), None)
    fake.pending = [_event("ITEM_RENAME", _folder("10", "crew"))]
    delta = await _pull(fake, hook, _root(), base.checkpoint)
    assert _kinds(delta) == {
        ("/box/team", FileChangeKind.DELETE),
        ("/box/team/a.txt", FileChangeKind.DELETE),
        ("/box/crew", FileChangeKind.CREATE),
        ("/box/crew/a.txt", FileChangeKind.CREATE),
    }
    # The id map moved with it: a later upload lands on the new path.
    crew = {"type": "folder", "id": "10", "name": "crew"}
    fake.pending = [_event("ITEM_UPLOAD", _file("1", "a.txt", "s9", crew))]
    again = await _pull(fake, hook, _root(), delta.checkpoint)
    assert _kinds(again) == {("/box/crew/a.txt", FileChangeKind.UPDATE)}


@pytest.mark.asyncio
async def test_copied_folder_is_walked_for_its_contents() -> None:
    fake = FakeBox({"0": []})
    hook = BoxDeltaHook(_accessor())
    base = await _pull(fake, hook, _root(), None)
    copy = {"type": "folder", "id": "20", "name": "copy"}
    fake.folders["20"] = [_file("21", "x.txt", "s21", copy)]
    fake.pending = [_event("ITEM_COPY", _folder("20", "copy"))]
    delta = await _pull(fake, hook, _root(), base.checkpoint)
    assert _kinds(delta) == {
        ("/box/copy", FileChangeKind.CREATE),
        ("/box/copy/x.txt", FileChangeKind.CREATE),
    }


@pytest.mark.asyncio
async def test_events_outside_the_watch_root_are_dropped() -> None:
    fake = FakeBox({
        "0": [_folder("10", "team"),
              _folder("11", "other")],
        "10": [],
    })
    hook = BoxDeltaHook(_accessor())
    root = _root("team")
    with patch("mirage.core.box.resolve.list_folder_items",
               fake.list_folder_items):
        base = await _pull(fake, hook, root, None)
    other = {"type": "folder", "id": "11", "name": "other"}
    fake.pending = [
        _event("ITEM_UPLOAD", _file("5", "n.txt", "s5", other)),
        _event("ITEM_UPLOAD", _file("6", "m.txt", "s6", TEAM)),
    ]
    delta = await _pull(fake, hook, root, base.checkpoint)
    assert _kinds(delta) == {("/box/team/m.txt", FileChangeKind.CREATE)}


@pytest.mark.asyncio
async def test_move_out_of_the_root_is_a_delete() -> None:
    fake = FakeBox({"0": [_folder("10", "team")], "10": []})
    hook = BoxDeltaHook(_accessor("10"))
    fake.folders["10"] = [_file("1", "a.txt", "s1", TEAM)]
    base = await _pull(fake, hook, _root(), None)
    fake.pending = [_event("ITEM_MOVE", _file("1", "a.txt", "s1"))]
    delta = await _pull(fake, hook, _root(), base.checkpoint)
    assert _kinds(delta) == {("/box/a.txt", FileChangeKind.DELETE)}


@pytest.mark.asyncio
async def test_listing_era_checkpoint_upgrades() -> None:
    fake = FakeBox({"0": [_file("1", "a.txt", "s1")]})
    old = json.dumps({"/box/a.txt": "s0|4", "/box/gone.txt": "s2|4"})
    delta = await _pull(fake, BoxDeltaHook(_accessor()), _root(), old)
    assert _kinds(delta) == {
        ("/box/a.txt", FileChangeKind.UPDATE),
        ("/box/gone.txt", FileChangeKind.DELETE),
    }
    assert json.loads(delta.checkpoint)["_box"] == 1


@pytest.mark.asyncio
async def test_checkpoint_older_than_the_replay_window_relists() -> None:
    fake = FakeBox({"0": [_file("1", "a.txt", "s1")]})
    hook = BoxDeltaHook(_accessor())
    base = await _pull(fake, hook, _root(), None)
    stale = json.loads(base.checkpoint)
    stale["t"] = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    fake.folders["0"] = [_file("1", "a.txt", "s1-v2")]
    fake.calls.clear()
    delta = await _pull(fake, hook, _root(), json.dumps(stale))
    assert fake.calls == ["now", "list 0"]
    assert _kinds(delta) == {("/box/a.txt", FileChangeKind.UPDATE)}


@pytest.mark.asyncio
async def test_event_hook_tracks_ids_across_events() -> None:
    hook = BoxEventHook(_accessor())
    root = _root()

    async def mapped(event_type: str, source: dict):
        out = await hook.to_events(root, event_type,
                                   _event(event_type, source))
        return [(c.kind, c.path.virtual,
                 c.previous_path.virtual if c.previous_path else None)
                for c in out]

    assert await mapped("ITEM_UPLOAD", _file("1", "a.txt", "s1")) == [
        (FileChangeKind.CREATE, "/box/a.txt", None)
    ]
    assert await mapped("ITEM_UPLOAD", _file("1", "a.txt", "s2")) == [
        (FileChangeKind.UPDATE, "/box/a.txt", None)
    ]
    assert await mapped("ITEM_RENAME", _file("1", "b.txt", "s2")) == [
        (FileChangeKind.MOVE, "/box/b.txt", "/box/a.txt")
    ]
    assert await mapped("ITEM_TRASH", _file("1", "b.txt", "s2")) == [
        (FileChangeKind.DELETE, "/box/b.txt", None)
    ]


@pytest.mark.asyncio
async def test_event_hook_move_of_unknown_item_is_unknown_on_parent() -> None:
    hook = BoxEventHook(_accessor())
    out = await hook.to_events(
        _root(), "ITEM_MOVE",
        _event("ITEM_MOVE", _file("7", "a.txt", "s7", TEAM)))
    assert [(c.kind, c.path.virtual)
            for c in out] == [(FileChangeKind.UNKNOWN, "/box/team")]


@pytest.mark.asyncio
async def test_event_hook_ignores_items_outside_the_mount() -> None:
    hook = BoxEventHook(_accessor("10"))
    elsewhere = {"type": "folder", "id": "11", "name": "other"}
    out = await hook.to_events(
        _root(), "ITEM_UPLOAD",
        _event("ITEM_UPLOAD", _file("5", "n.txt", "s5", elsewhere)))
    assert out == ()
    inside = await hook.to_events(
        _root(), "ITEM_UPLOAD",
        _event("ITEM_UPLOAD", _file("6", "m.txt", "s6", TEAM)))
    assert [(c.kind, c.path.virtual)
            for c in inside] == [(FileChangeKind.CREATE, "/box/m.txt")]
