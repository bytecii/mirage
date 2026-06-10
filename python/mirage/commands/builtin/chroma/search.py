from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.chroma import search as search_core
from mirage.core.chroma.glob import resolve_glob
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def default_paths(paths: list[PathSpec],
                  cwd: PathSpec | None) -> list[PathSpec]:
    if paths:
        return paths
    if cwd is not None:
        return [cwd]
    return [PathSpec(original="/", directory="/")]


def is_mount_root(path: PathSpec) -> bool:
    root = path.prefix.rstrip("/") if path.prefix else "/"
    root = root or "/"
    value = path.original.rstrip("/") or "/"
    return value == "/" or value == root


@command("chroma-query", resource="chroma", spec=SPECS["search"])
async def search(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    top_k: str | int = 10,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("search: query is required")
    query = texts[0]
    index = _extra.get("index")
    cwd = _extra.get("cwd")
    target_paths = default_paths(paths,
                                 cwd if isinstance(cwd, PathSpec) else None)
    mount_prefix = target_paths[0].prefix if target_paths else ""
    if any(is_mount_root(path) for path in target_paths):
        resolved_paths: list[PathSpec] = []
    else:
        resolved_paths = await resolve_glob(accessor, target_paths, index)
    output = await search_core.search_segments(accessor,
                                               query,
                                               resolved_paths,
                                               index,
                                               top_k=int(top_k),
                                               mount_prefix=mount_prefix)
    return output, IOResult()
