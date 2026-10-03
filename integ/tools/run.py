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
"""The tool corpus in-app on the Python host.

Each case runs through MirageToolOperations.call, the entry every door
shares, on one workspace built by the corpus setup. Run from the
repository root:
    ./python/.venv/bin/python integ/tools/run.py

With --print, writes the answers instead of checking them, for pinning a
new case's expect.
"""

import asyncio
import json
import sys
from pathlib import Path

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.tool_operations import MirageToolOperations

SUITE = Path(__file__).with_name("cases.json")


async def answers(suite: dict) -> list[dict]:
    """Run every case in order and collect its answer.

    Args:
        suite (dict): the corpus.

    Returns:
        list[dict]: one ``{"id", "text", "is_error"}`` per case.
    """
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        for line in suite["setup"]:
            io = await ws.shell(line)
            assert io.exit_code == 0, (line, await io.stderr_str())
        ops = MirageToolOperations(ws)
        got = []
        for case in suite["cases"]:
            result = await ops.call(case["tool"], case["input"])
            got.append(
                {
                    "id": case["id"],
                    "text": result.text,
                    "is_error": result.is_error,
                }
            )
        return got
    finally:
        await ws.close()


def main() -> int:
    suite = json.loads(SUITE.read_text())
    got = asyncio.run(answers(suite))
    if "--print" in sys.argv[1:]:
        print(json.dumps(got, indent=1))
        return 0
    failures = 0
    for case, answer in zip(suite["cases"], got, strict=True):
        want = case["expect"]
        if [answer["text"], answer["is_error"]] != [
            want["text"],
            want["is_error"],
        ]:
            failures += 1
            print(f"FAIL {case['id']}: got {answer!r}, want {want!r}")
    print(f"tools (python in-app): {len(got) - failures}/{len(got)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
