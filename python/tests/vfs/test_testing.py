from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from mirage import ReadFixture, check_read_contract
from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.ram.io import IO
from mirage.types import PathSpec
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.ram.store import RAMStore
from mirage.vfs.types import ReadOps

FILE = PathSpec(virtual="/data/a.txt", directory="/data", vfs_path="a.txt")
DIRECTORY = PathSpec(virtual="/data", directory="/", vfs_path="")
MISSING = PathSpec(virtual="/data/missing",
                   directory="/data",
                   vfs_path="missing")
CONTENT = "é: hello\n".encode()
FIXTURE = ReadFixture(FILE, DIRECTORY, MISSING, CONTENT)


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [False, True])
async def test_builtin_and_minimal_adapter_share_the_contract(native):
    accessor = RAMAccessor(RAMStore())
    await IO.write(accessor, FILE, CONTENT)
    adapter = IO if native else VFSAdapter(read=ReadOps(
        readdir=IO.readdir, read_bytes=IO.read_bytes, stat=IO.stat))
    await check_read_contract(adapter, accessor, FIXTURE)


@pytest.mark.asyncio
async def test_contract_catches_ranges_using_end_instead_of_size():
    accessor = RAMAccessor(RAMStore())
    await IO.write(accessor, FILE, CONTENT)

    async def broken_range(a, p, i, offset, size):
        return CONTENT[offset:size]

    with pytest.raises(AssertionError, match="offset and byte count"):
        await check_read_contract(replace(IO, read_range=broken_range),
                                  accessor, FIXTURE)


@pytest.mark.asyncio
async def test_contract_propagates_permission_failure():
    accessor = RAMAccessor(RAMStore())
    read = AsyncMock(side_effect=PermissionError("denied"))
    with pytest.raises(PermissionError, match="denied"):
        await check_read_contract(replace(IO, read_bytes=read), accessor,
                                  FIXTURE)
