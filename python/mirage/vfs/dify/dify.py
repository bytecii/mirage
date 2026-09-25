from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.commands.builtin.dify import COMMANDS
from mirage.commands.builtin.dify.io import IO
from mirage.ops.dify import OPS as DIFY_VFS_OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.dify.config import DifyConfig
from mirage.vfs.dify.prompt import PROMPT


class DifyVFS(BoundVFS):

    accessor: DifyAccessor
    name: str = VFSName.DIFY
    caches_reads: bool = True
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = False

    def __init__(self, config: DifyConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self.accessor = DifyAccessor(config)

        for fn in COMMANDS:
            self.register(fn)
        for fn in DIFY_VFS_OPS:
            self.register_op(fn)

    def get_state(self) -> dict[str, Any]:
        redacted = ["api_key"]
        config = self.config.model_dump()
        if config.get("api_key") is not None:
            config["api_key"] = "<REDACTED>"
        return {
            "type": self.name,
            "needs_override": True,
            "redacted_fields": redacted,
            "config": config,
        }
