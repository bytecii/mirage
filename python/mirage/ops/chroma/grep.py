from mirage.core.chroma.grep import grep_bytes
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("grep", resource="chroma")
async def grep(accessor, paths: list[PathSpec], pattern: str, *, index,
               **kwargs) -> bytes:
    output, _reads = await grep_bytes(accessor, paths, pattern, index)
    return output
