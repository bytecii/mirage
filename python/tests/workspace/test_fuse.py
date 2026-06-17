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

import subprocess

import mirage.fuse.mount as fuse_mount
from mirage.workspace.fuse import FuseManager


class TestFuseManager:

    def test_initial_state(self):
        fm = FuseManager()
        assert fm.mountpoint is None

    def test_set_mountpoint(self):
        fm = FuseManager()
        fm.mountpoint = "/tmp/test-fuse"
        assert fm.mountpoint == "/tmp/test-fuse"

    def test_close_without_auto_does_nothing(self):
        fm = FuseManager()
        fm.mountpoint = "/tmp/test-fuse"
        fm.close()
        assert fm.mountpoint == "/tmp/test-fuse"

    def test_close_without_mountpoint_does_nothing(self):
        fm = FuseManager()
        fm.close()
        assert fm.mountpoint is None

    def test_close_keeps_caller_owned_mountpoint(self, monkeypatch, tmp_path):
        # Regression: explicit mountpoints are caller-owned deployment paths.
        # close() should unmount FUSE, not remove the directory the caller gave.
        monkeypatch.setattr(fuse_mount, "mount_background",
                            lambda *_args, **_kwargs: None)
        monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)

        fm = FuseManager()
        fm.setup(object(), mountpoint=str(tmp_path))
        fm.close()

        assert tmp_path.exists()
        assert fm.mountpoint is None
