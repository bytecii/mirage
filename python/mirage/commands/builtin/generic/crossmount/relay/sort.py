from functools import partial
from typing import cast

from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import (_relay_write,
                                                              flat_scopes,
                                                              relay)
from mirage.commands.builtin.generic.sort import sort as generic_sort
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec


async def run_sort(scopes: list[PathSpec], flags: dict[str, FlagValue],
                   dispatch: DispatchFn,
                   stdin: ByteSource | None) -> CrossResult:
    """Sort independent inputs through the same generic on every mount.

    Args:
        scopes (list[PathSpec]): Expanded operands in command-line order.
        flags (dict[str, FlagValue]): Parsed options.
        dispatch (DispatchFn): Workspace operation dispatcher.
        stdin (ByteSource | None): Shared standard input cursor.
    """

    async def read_file(path: PathSpec) -> bytes:
        info = await relay(dispatch, "stat", path)
        if info.type is FileType.DIRECTORY:
            raise IsADirectoryError(path.virtual)
        return cast(bytes, await relay(dispatch, "read", path))

    return await generic_sort(flat_scopes(scopes),
                              read_bytes=read_file,
                              write_bytes=partial(_relay_write, dispatch),
                              stdin=stdin,
                              flags=flags)
