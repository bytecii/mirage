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
import subprocess
import sys
import tempfile
from threading import Thread


class FuseManager:

    def __init__(self) -> None:
        self._mountpoint: str | None = None
        self._thread: Thread | None = None
        self._auto: bool = False
        # True only for tempfile mountpoints Mirage created and may delete.
        self._owns_mountpoint: bool = False

    @property
    def mountpoint(self) -> str | None:
        return self._mountpoint

    @mountpoint.setter
    def mountpoint(self, path: str | None) -> None:
        self._mountpoint = path
        self._owns_mountpoint = False

    def setup(self,
              ws: object,
              root_prefix: str = "",
              mountpoint: str | None = None) -> None:
        from mirage.fuse.mount import mount_background
        if mountpoint:
            # Caller/deployment-owned mountpoints may be reused across process
            # restarts, container lifecycles, or volume mounts. Mirage should
            # unmount them, but must not delete the directory itself.
            os.makedirs(mountpoint, exist_ok=True)
            self._mountpoint = mountpoint
            self._owns_mountpoint = False
        else:
            self._mountpoint = tempfile.mkdtemp(prefix="mirage-")
            self._owns_mountpoint = True
        self._thread = mount_background(ws,
                                        self._mountpoint,
                                        root_prefix=root_prefix)
        self._auto = True

    def unmount(self) -> None:
        if not self._mountpoint:
            return
        if sys.platform == "darwin":
            subprocess.run(["diskutil", "unmount", "force", self._mountpoint],
                           capture_output=True)
        else:
            subprocess.run(["fusermount", "-u", self._mountpoint],
                           capture_output=True)
        if self._owns_mountpoint:
            try:
                # Empty-directory cleanup only. If the mount is still live or
                # the directory has contents, leave it for the caller/admin.
                os.rmdir(self._mountpoint)
            except OSError:
                pass
        self._mountpoint = None
        self._owns_mountpoint = False

    def close(self) -> None:
        if self._mountpoint and self._auto:
            self.unmount()
