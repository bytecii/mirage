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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.commands.builtin.langfuse import COMMANDS
from mirage.commands.builtin.langfuse.io import IO
from mirage.ops.langfuse import OPS as LANGFUSE_VFS_OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.langfuse.config import LangfuseConfig
from mirage.vfs.langfuse.prompt import PROMPT


class LangfuseVFS(BoundVFS):

    accessor: LangfuseAccessor
    name: str = VFSName.LANGFUSE
    caches_reads: bool = True
    PROMPT: str = PROMPT

    def __init__(self, config: LangfuseConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self.accessor = LangfuseAccessor(self.config)
        for fn in COMMANDS:
            self.register(fn)
        for fn in LANGFUSE_VFS_OPS:
            self.register_op(fn)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
