import json
from pathlib import Path

import pytest

from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

CORPUS = Path(
    __file__).resolve().parents[5] / "integ/crossmount/program/files.json"
CASES = json.loads(CORPUS.read_text())["cases"]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
async def test_program_file_routing(case):
    ws = Workspace({"/data": RAMVFS(), "/data2": RAMVFS()}, mode="exec")
    try:
        result = await ws.shell(case["command"])
        expected = case["expect"]
        assert (result.exit_code, result.stdout or b"", result.stderr
                or b"") == (expected["exit"], expected["stdout"].encode(),
                            expected["stderr"].encode())
    finally:
        await ws.close()
