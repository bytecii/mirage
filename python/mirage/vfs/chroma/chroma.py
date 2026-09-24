from typing import Any

from mirage.accessor.chroma import ChromaAccessor
from mirage.commands.builtin.chroma import COMMANDS
from mirage.commands.builtin.chroma.io import IO
from mirage.ops.chroma import OPS as CHROMA_VFS_OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.chroma.config import ChromaConfig
from mirage.vfs.chroma.prompt import PROMPT


class ChromaVFS(BoundVFS):

    accessor: ChromaAccessor
    name: str = VFSName.CHROMA
    caches_reads: bool = False
    # Every file is sized exactly, by one chunk scan per directory the
    # caller stats; the path tree's own size is the producer's source
    # number and never becomes the reported byte length.
    SIZES_ALWAYS_KNOWN: bool = True
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = False

    def __init__(self, config: ChromaConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self.accessor = ChromaAccessor(config)

        for fn in COMMANDS:
            self.register(fn)
        for fn in CHROMA_VFS_OPS:
            self.register_op(fn)

    def get_state(self) -> dict[str, Any]:
        return {
            "type": self.name,
            "needs_override": True,
            "redacted_fields": [],
            "config": self.config.model_dump(),
        }
