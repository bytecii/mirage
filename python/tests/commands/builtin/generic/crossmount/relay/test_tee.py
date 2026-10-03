import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_relay_tee_checks_every_output_before_writing_any():
    left, right = RAMVFS(), RAMVFS()
    ws = Workspace({"/a": left, "/b": right}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "printf x | tee --output-error=exit /a/one /b/nope/two /a/three"
        )
        assert result.exit_code == 1
        assert await result.materialize_stdout() == b""
        assert (
            result.stderr == b"tee: /b/nope/two: No such file or directory\n"
        )
        listing = await ws.shell(
            "ls /a; cat /a/one; printf y | tee /a/one /b/two"
        )
        assert await listing.materialize_stdout() == b"one\ny"
        both = await ws.shell("cat /a/one /b/two")
        assert await both.materialize_stdout() == b"yy"
    finally:
        await ws.close()
