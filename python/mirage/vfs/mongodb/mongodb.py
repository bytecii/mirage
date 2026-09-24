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

from typing import Any

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.commands.builtin.mongodb import COMMANDS
from mirage.commands.builtin.mongodb.io import IO
from mirage.ops.mongodb import OPS as MONGODB_VFS_OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.mongodb.config import MongoDBConfig
from mirage.vfs.mongodb.prompt import PROMPT


class MongoDBVFS(BoundVFS):

    accessor: MongoDBAccessor
    name: str = VFSName.MONGODB
    caches_reads: bool = False
    # A live store: every readdir must hit the backend, so the index is
    # not reused across commands. Mirrors the TypeScript VFS.
    index_ttl: float = 0
    PROMPT: str = PROMPT

    def __init__(self, config: MongoDBConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self.accessor = MongoDBAccessor(self.config)
        for fn in COMMANDS:
            self.register(fn)
        for op in MONGODB_VFS_OPS:
            self.register_op(op)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
