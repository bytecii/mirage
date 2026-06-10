from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.chroma.glob import resolve_glob
from mirage.core.chroma.grep import grep_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("grep", resource="chroma", spec=SPECS["grep"])
async def grep(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    r: bool = False,
    R: bool = False,
    i: bool = False,
    args_i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    E: bool = False,
    o: bool = False,
    m: str | None = None,
    q: bool = False,
    H: bool = False,
    args_h: bool = False,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    e: str | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    index = _extra.get("index")
    paths = await resolve_glob(accessor, paths, index)
    if e is not None:
        pattern = e
    elif texts:
        pattern = texts[0]
    else:
        raise ValueError("grep: usage: grep [flags] pattern [path]")
    output, reads = await grep_bytes(
        accessor,
        paths,
        pattern,
        index,
        ignore_case=i or args_i,
        invert=v,
        line_numbers=n,
        count_only=c,
        files_only=args_l,
        whole_word=w,
        fixed_string=F,
        only_matching=o,
        max_count=int(m) if m is not None else None)
    io = IOResult(reads=reads, cache=list(reads), exit_code=0 if output else 1)
    if q:
        return b"", io
    return output, io
