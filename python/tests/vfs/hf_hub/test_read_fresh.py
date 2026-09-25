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

import pytest

from mirage.core.hf_hub.read import read_bytes
from mirage.observe.context import RecordingScope
from mirage.types import MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.snapshot.drift import ContentDriftError
from mirage.workspace.snapshot.state import to_state_dict
from tests.fixtures.hf_hub_api import FakeHub, blob_oid, serve

REPO = ("models", "acme/widget")
OLD = b"version one\n"
NEW = b"version two, longer\n"


def _hub(files: dict[str, bytes], **kwargs) -> FakeHub:
    return FakeHub(repos={REPO: dict(files)}, **kwargs)


def _vfs(hub: FakeHub):
    return build_vfs("hf_models", {"repo_id": "acme/widget",
                                   "endpoint": hub.url})


def _ws(vfs, policy: ReadPolicy = ReadPolicy.FRESH) -> Workspace:
    return Workspace({
        "/m": Mount(vfs=vfs, mode=MountMode.READ,
                    read=ReadSpec(policy=policy)),
        "/r": (RAMVFS(), MountMode.WRITE),
    })


async def _out(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


def _files(hub: FakeHub) -> dict[str, bytes]:
    return hub.repos[REPO]


@pytest.mark.asyncio
async def test_a_revert_never_serves_other_bytes_as_fresh():
    # The listing still describes OLD while the download already serves
    # NEW: the read must not label NEW with OLD's oid, or a revert back to
    # OLD makes the probe agree and NEW is served as if it were OLD.
    with serve(_hub({"a.txt": NEW}, listed={"a.txt": OLD})) as hub:
        vfs = _vfs(hub)
        ws = _ws(vfs)
        try:
            assert await _out(ws, "cat /m/a.txt") == NEW
            # The fixture held: the listing was OLD's, and the cached copy
            # carries no token rather than OLD's oid.
            assert vfs.accessor.tree_loaded
            assert not await ws.cache.is_fresh("/m/a.txt", blob_oid(OLD))
            _files(hub)["a.txt"] = OLD
            before = hub.count("resolve")
            assert await _out(ws, "cat /m/a.txt") == OLD
            assert hub.count("resolve") == before + 1
            # The refetch was verified, so it restamped and now serves warm.
            before = hub.count("resolve")
            assert await _out(ws, "cat /m/a.txt") == OLD
            assert hub.count("resolve") == before
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_probe_leaves_find_its_whole_listing():
    with serve(_hub({"a.txt": OLD, "d/b.txt": NEW})) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, "cat /m/a.txt")
            await _out(ws, "cat /m/a.txt")
            walks = hub.count("tree")
            listed = await _out(ws, "find /m -type f")
            assert listed.decode().split() == ["/m/a.txt", "/m/d/b.txt"]
            assert hub.count("tree") == walks
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_mount_that_cannot_see_its_repo_fails_loudly():
    with serve(_hub({"a.txt": OLD}, fail={"tree": (401, "")})) as hub:
        ws = _ws(_vfs(hub), ReadPolicy.BOUNDED)
        try:
            ls = await ws.shell("ls /m")
            assert ls.exit_code == 1
            assert await ls.stderr_str() == "ls: fake tree refused\n"
            cat = await ws.shell("cat /m/a.txt")
            assert cat.exit_code == 1
            assert await cat.stderr_str() == "cat: fake tree refused\n"
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_an_expired_token_keeps_the_overlay():
    with serve(_hub({"a.txt": OLD})) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, "cat /m/a.txt")
            await ws.namespace.set_attrs("/m/a.txt", mode=0o600)
            hub.fail.update({"tree": (401, ""), "paths_info": (401, "")})
            # Cross-mount cp reads through the dispatcher, the door whose
            # "no such file" drops the overlay; a plain cat never reaches it.
            cp = await ws.shell("cp /m/a.txt /r/x")
            assert cp.exit_code == 1
            assert "fake" in await cp.stderr_str()
            meta = ws.namespace.meta_for("/m/a.txt")
            assert meta is not None and meta.mode == 0o600
        finally:
            await ws.close()


async def _pinned_state(hub: FakeHub):
    ws = _ws(_vfs(hub))
    try:
        await _out(ws, "cat /m/a.txt")
        return await to_state_dict(ws)
    finally:
        await ws.close()


async def _load(state, vfs):
    loaded = await Workspace.from_state(state, mounts={"/m": vfs})
    try:
        await _out(loaded, "cat /m/a.txt")
    finally:
        await loaded.close()


@pytest.mark.asyncio
async def test_a_verified_read_pins_and_a_changed_file_drifts():
    with serve(_hub({"a.txt": OLD})) as hub:
        state = await _pinned_state(hub)
        _files(hub)["a.txt"] = NEW
        walks = hub.count("tree")
        with pytest.raises(ContentDriftError):
            await _load(state, _vfs(hub))
        # A restored mount has not loaded its tree, so the check walks it.
        assert hub.count("tree") > walks


@pytest.mark.asyncio
async def test_an_unverified_read_pins_nothing():
    with serve(_hub({"a.txt": NEW}, listed={"a.txt": OLD})) as hub:
        state = await _pinned_state(hub)
        hub.listed.clear()
        # Upstream is at NEW, which is what the agent actually read; a pin
        # of the listing's OLD oid would raise a drift that never happened.
        await _load(state, _vfs(hub))


@pytest.mark.asyncio
async def test_a_drift_check_the_hub_refuses_is_not_drift():
    with serve(_hub({"a.txt": OLD})) as hub:
        state = await _pinned_state(hub)
        hub.fail["tree"] = (401, "")
        with pytest.raises(Exception) as caught:
            await _load(state, _vfs(hub))
        assert not isinstance(caught.value, ContentDriftError)
        assert "fake tree refused" in str(caught.value)


@pytest.mark.asyncio
async def test_a_drift_check_on_a_loaded_mount_asks_one_path():
    with serve(_hub({"a.txt": OLD})) as hub:
        vfs = _vfs(hub)
        ws = _ws(vfs)
        try:
            await _out(ws, "cat /m/a.txt")
            state = await to_state_dict(ws)
        finally:
            await ws.close()
        _files(hub)["a.txt"] = NEW
        walks = hub.count("tree")
        with pytest.raises(ContentDriftError):
            await _load(state, vfs)
        assert hub.count("tree") == walks
        assert hub.count("paths_info") >= 1
        hub.fail["paths_info"] = (401, "")
        with pytest.raises(Exception) as caught:
            await _load(state, vfs)
        assert not isinstance(caught.value, ContentDriftError)


# Measured on the first green run, then pinned (test plan T31): each
# number is one reconcile probe, and a warm read makes no tree walk and no
# download.
WARM = [
    ("cat /m/a.txt", 2),
    ("cat /m/a.txt | head -c 1", None),
    ("cp /m/a.txt /r/a.txt", None),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line,posts", WARM)
async def test_a_warm_fresh_read_costs_one_path_per_probe(line, posts):
    with serve(_hub({"a.txt": OLD})) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, "cat /m/a.txt")
            hub.log.clear()
            await _out(ws, line)
            assert (hub.count("paths_info"), hub.count("tree"),
                    hub.count("resolve")) == (posts, 0, 0)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_new_mount_loads_its_tree_once_and_never_asks_one_path():
    with serve(_hub({"a.txt": OLD})) as hub:
        ws = _ws(_vfs(hub), ReadPolicy.BOUNDED)
        try:
            await _out(ws, "stat -c %s /m/a.txt")
            await _out(ws, "stat -c %s /m/a.txt")
            await _out(ws, "ls /m")
            assert (hub.count("tree"), hub.count("paths_info")) == (1, 0)
        finally:
            await ws.close()


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual="/" + path,
                    directory="/",
                    vfs_path=path,
                    raw_path="/" + path)


@pytest.mark.asyncio
@pytest.mark.parametrize("override,expected", [(None, True), ("other", False)])
async def test_a_ranged_read_stamps_the_whole_files_oid(override, expected):
    with serve(_hub({"a.txt": OLD})) as hub:
        if override is not None:
            hub.etags["a.txt"] = override
        vfs = _vfs(hub)
        scope = RecordingScope()
        try:
            data = await read_bytes(vfs.accessor, _spec("a.txt"),
                                    offset=2, size=3)
        finally:
            scope.close()
            await vfs.accessor.close()
        assert data == OLD[2:5]
        stamped = [r.fingerprint for r in scope.records]
        assert stamped == ([blob_oid(OLD)] if expected else [None])
