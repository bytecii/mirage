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

import os
import shutil
import tempfile
import time

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource


def main() -> None:
    data = RAMResource()
    data._store.dirs.add("/")
    data._store.files["/a.txt"] = b"alpha\n"
    logs = RAMResource()
    logs._store.dirs.add("/")
    logs._store.files["/b.txt"] = b"beta\n"

    pinned = os.path.join(tempfile.gettempdir(),
                          f"mirage-fuse-data-{os.getpid()}")
    shutil.rmtree(pinned, ignore_errors=True)
    with Workspace(
        {
            "/data": (data, MountMode.WRITE),
            "/logs": (logs, MountMode.WRITE),
        },
            mode=MountMode.WRITE,
            fuse_mounts={
                "/data": pinned,
                "/logs": True,
            }) as ws:
        time.sleep(1)
        points = ws.fuse_mountpoints
        data_mp = points["/data"]
        logs_mp = points["/logs"]

        with open(f"{data_mp}/a.txt", "rb") as fh:
            print(f"data_cat_a={fh.read().decode().strip()}")
        with open(f"{logs_mp}/b.txt", "rb") as fh:
            print(f"logs_cat_b={fh.read().decode().strip()}")
        print(f"logs_size_b={os.path.getsize(f'{logs_mp}/b.txt')}")
        print(f"data_pinned={'yes' if data_mp == pinned else 'no'}")
        print(f"distinct_mounts={'yes' if data_mp != logs_mp else 'no'}")


if __name__ == "__main__":
    main()
