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

import aiofiles
import aiofiles.os


class DiskObserverStore:
    """ObserverStore backed by a directory of JSONL files.

    Args:
        root (str): Directory holding the recorder's files; created on
            first append.
    """

    def __init__(self, root: str) -> None:
        self._root = root

    def _abs(self, path: str) -> str:
        return os.path.join(self._root, path.lstrip("/"))

    async def append(self, path: str, data: bytes) -> None:
        """Append bytes to the file at path, creating parents.

        Args:
            path (str): File key.
            data (bytes): Bytes to append.
        """
        abs_path = self._abs(path)
        await aiofiles.os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        async with aiofiles.open(abs_path, "ab") as f:
            await f.write(data)

    async def write(self, path: str, data: bytes) -> None:
        """Overwrite the file at path, creating parents.

        Args:
            path (str): File key.
            data (bytes): Full new content.
        """
        abs_path = self._abs(path)
        await aiofiles.os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        async with aiofiles.open(abs_path, "wb") as f:
            await f.write(data)

    async def read_all(self) -> dict[str, bytes]:
        """Read every stored file under root.

        Returns:
            dict[str, bytes]: Mapping of file key to content.
        """
        out: dict[str, bytes] = {}
        if not os.path.isdir(self._root):
            return out
        for dirpath, _dirs, files in os.walk(self._root):
            for name in files:
                abs_path = os.path.join(dirpath, name)
                rel = "/" + os.path.relpath(abs_path, self._root)
                async with aiofiles.open(abs_path, "rb") as f:
                    out[rel] = await f.read()
        return out
