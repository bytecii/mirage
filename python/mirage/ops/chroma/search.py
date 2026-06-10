from mirage.core.chroma import search as search_core
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("search", resource="chroma")
async def search(accessor, paths: list[PathSpec], query: str, *, index,
                 **kwargs) -> bytes:
    explicit_prefix = kwargs.pop("mount_prefix", "")
    mount_prefix = paths[0].prefix if paths else explicit_prefix
    return await search_core.search_segments(accessor,
                                             query,
                                             paths,
                                             index,
                                             mount_prefix=mount_prefix,
                                             **kwargs)
