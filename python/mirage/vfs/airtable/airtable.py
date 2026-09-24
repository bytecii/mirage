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

from mirage.accessor.airtable import AirtableAccessor
from mirage.commands.builtin.airtable import COMMANDS
from mirage.core.airtable.config import AirtableConfig
from mirage.core.airtable.read import read
from mirage.core.airtable.readdir import readdir
from mirage.core.airtable.stat import stat
from mirage.ops.airtable import OPS
from mirage.types import PathSpec, VFSName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.vfs.airtable.prompt import PROMPT, WRITE_PROMPT
from mirage.vfs.base import BaseVFS

_resolve_glob = make_resolve_glob(readdir)

_AIRTABLE_OPS = {
    "read_bytes": read,
    "readdir": readdir,
    "stat": stat,
}


class AirtableVFS(BaseVFS):
    """Airtable bases as directories, tables as records.jsonl files.

    Records are live data another client may edit at any moment, so reads
    are never served from the file cache; the schema listings still ride
    the index for its TTL.

    Args:
        config (AirtableConfig): the account and its bounds.
    """

    accessor: AirtableAccessor
    name: str = VFSName.AIRTABLE
    caches_reads: bool = False
    _ops: dict[str, Any] = _AIRTABLE_OPS
    PROMPT: str = PROMPT
    WRITE_PROMPT: str = WRITE_PROMPT

    def __init__(self, config: AirtableConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = AirtableAccessor(self.config)
        for fn in COMMANDS:
            self.register(fn)
        for op in OPS:
            self.register_op(op)

    async def resolve_glob(
        self,
        paths: list[PathSpec],
        prefix: str = '',
    ) -> list[PathSpec]:
        return await _resolve_glob(self.accessor, paths, index=self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
