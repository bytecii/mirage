from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from mirage import GenericVFS, MountMode, PathSpec, Workspace
from mirage.commands.builtin.ram.io import IO
from mirage.vfs.bound import BoundVFS
from mirage.vfs.ram import RAMVFS


@pytest.mark.asyncio
async def test_range_forwarder_uses_replaced_index_and_byte_count():
    native = AsyncMock(return_value=b"ell")
    vfs = BoundVFS(io=replace(IO, read_range=native))
    vfs.set_index()
    path = PathSpec(virtual="/a", directory="/", vfs_path="a")
    assert await vfs.range_read(path, 1, 4) == b"ell"
    native.assert_awaited_once_with(vfs.accessor, path, vfs.index, 1, 3)
    await vfs.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("custom", [False, True])
async def test_builtin_and_custom_writes_obey_mount_mode(custom):
    builtin = RAMVFS()
    path = PathSpec(virtual="/data/a", directory="/data", vfs_path="a")
    await builtin.write(path, b"before")
    vfs = GenericVFS(name="probe", accessor=builtin.accessor,
                     io=IO) if custom else builtin
    ws = Workspace({"/data": vfs}, mode=MountMode.READ)
    try:
        result = await ws.shell("echo after > /data/a")
        assert result.exit_code != 0
        assert await vfs.read_bytes(path) == b"before"
    finally:
        await ws.close()
        if custom:
            await builtin.close()
