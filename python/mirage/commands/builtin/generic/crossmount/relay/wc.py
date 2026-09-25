from typing import cast

from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import flat_scopes, relay
from mirage.commands.builtin.generic.wc import wc_generic
from mirage.commands.config import CommandOpts
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec


async def run_wc(scopes: list[PathSpec],
                 flag_kwargs: dict[str, FlagValue],
                 dispatch: DispatchFn,
                 stdin: ByteSource | None = None) -> CrossResult:
    """Count every operand together through the shared wc generic.

    Args:
        scopes (list[PathSpec]): Expanded operands in command-line order.
        flag_kwargs (dict): Parsed wc flags.
        dispatch (DispatchFn): Workspace operation dispatcher.
        stdin (ByteSource | None): Shared standard input cursor.
    """

    async def read(path: PathSpec) -> bytes:
        info = await relay(dispatch, "stat", path)
        if info.type is FileType.DIRECTORY:
            raise IsADirectoryError(path.virtual)
        return cast(bytes, await relay(dispatch, "read", path))

    return await wc_generic(flat_scopes(scopes), [],
                            CommandOpts(flags=flag_kwargs, stdin=stdin), read)
