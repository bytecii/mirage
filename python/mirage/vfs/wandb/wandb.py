from typing import Any

from mirage.accessor.wandb import WandbAccessor
from mirage.commands.builtin.wandb import COMMANDS
from mirage.commands.builtin.wandb.io import IO
from mirage.core.wandb.config import WandbConfig
from mirage.ops.wandb import OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.wandb.prompt import PROMPT


class WandbVFS(BoundVFS):
    name: str = VFSName.WANDB
    PROMPT: str = PROMPT

    def __init__(self, config: WandbConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self.accessor = WandbAccessor(config)
        for command in COMMANDS:
            self.register(command)
        for op in OPS:
            self.register_op(op)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
