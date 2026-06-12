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

import asyncio

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource

CASES: list[tuple[str, str, str]] = [
    # ----- seed commands (their outputs are part of the record) -----
    ("seed_echo_one", "default", "echo marker-one"),
    ("seed_echo_two", "default", "echo marker-two"),
    ("seed_write", "default", "echo persisted > /data/h.txt"),
    ("seed_cat", "default", "cat /data/h.txt"),
    ("seed_s2_echo", "s2", "echo marker-s2"),
    # ----- history builtin: session projection -----
    ("history_default_session", "default", "history"),
    ("history_last_2", "default", "history 2"),
    ("history_s2_isolated", "s2", "history"),
    # ----- /.bash_history: GNU file across ALL sessions -----
    ("bash_history_commands", "default", "grep -v '^#' /.bash_history"),
    ("bash_history_grep_marker", "default", "grep marker-s2 /.bash_history"),
    ("bash_history_timestamp_lines", "default", "grep -c '^#' /.bash_history"),
    ("bash_history_pipe", "default",
     "cat /.bash_history | grep -c marker-one"),
    # ----- dotfile visibility -----
    ("ls_root_hides_dotfile", "default", "ls /"),
    ("ls_a_root_shows_dotfile", "default", "ls -a /"),
    # ----- history -c: clears only the calling session -----
    ("history_clear_s2", "s2", "history -c"),
    ("history_s2_after_clear", "s2", "history"),
    ("history_default_after_s2_clear", "default", "history 1"),
    ("bash_history_survives_clear", "default",
     "grep -c marker-s2 /.bash_history"),
]

EXIT_CODE_CASES: list[tuple[str, str, str]] = [
    ("append_rejected", "default", "echo hacked >> /.bash_history"),
    ("sessions_path_gone", "default", "ls /.sessions"),
    ("history_non_numeric", "default", "history abc"),
]


async def main() -> None:
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    ws.create_session("s2")

    for name, session, cmd in CASES:
        result = await ws.execute(cmd, session_id=session)
        out = await result.stdout_str()
        print(f"=== {name} ===")
        print(out, end="" if out.endswith("\n") else "\n")

    for name, session, cmd in EXIT_CODE_CASES:
        result = await ws.execute(cmd, session_id=session)
        print(f"=== {name} ===")
        print(f"nonzero_exit={result.exit_code != 0}")

    # ----- observer: the hidden recorder behind the views -----
    events = await ws.observer.events()
    types = sorted({e["type"] for e in events})
    print("=== observer_event_types ===")
    print(",".join(types))

    commands = await ws.history()
    print("=== observer_command_events ===")
    print(f"first={commands[0]['command']}")
    print(f"sessions={sorted({e['session'] for e in commands})}")
    print(f"marker_commands="
          f"{sum(1 for e in commands if 'marker' in e['command'])}")
    print(f"all_have_exit_code="
          f"{all('exit_code' in e for e in commands)}")
    print(f"all_have_cwd={all('cwd' in e for e in commands)}")

    print("=== observer_op_events ===")
    ops = [e for e in events if e["type"] == "op"]
    read_paths = {e["path"] for e in ops if e["op"] == "read"}
    print(f"read_h_txt={'/data/h.txt' in read_paths}")
    print(f"ops_have_source={all('source' in e for e in ops)}")

    print("=== observer_session_projection ===")
    s2_events = await ws.observer.session_command_events("s2")
    default_events = await ws.observer.session_command_events("default")
    print(f"s2_after_clear={[e['command'] for e in s2_events]}")
    print(f"default_first={default_events[0]['command']}")

    print("=== observer_not_mounted ===")
    prefixes = sorted(m.prefix for m in ws._registry.mounts())
    print(f"mounts={prefixes}")
    print(
        f"recorder_mounted="
        f"{ws.observer.store in [m.resource for m in ws._registry.mounts()]}")


if __name__ == "__main__":
    asyncio.run(main())
