import re
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from functools import partial

from mirage.cache.read_through import (cache_aware_bound_bytes,
                                       cache_aware_bound_stream)
from mirage.commands.builtin.grep_offsets import decode_line
from mirage.commands.builtin.grep_pattern import (  # yapf: disable
    compile_pattern, resolve_pattern)
from mirage.commands.builtin.grep_scan import (exit_code_for,
                                               grep_count_has_matches,
                                               grep_lines, grep_stream,
                                               nonzero_count_stream)
from mirage.commands.builtin.rg_scan import rg_full
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat,
                                                mount_parent_readdir,
                                                mount_parent_stat)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, WALK_ERRORS, fs_strerror
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import respell_raw

# ripgrep's own words for a line with no pattern, exit 2 (14.1.1).
RG_NO_PATTERN = "rg: ripgrep requires at least one pattern to execute a search"
# ripgrep's name for stdin wherever it names the file a line came from.
STDIN_NAME = "<stdin>"
# The operand ripgrep searches when a line names none and stdin is piped.
IMPLICIT_STDIN = PathSpec(virtual="-", directory="-", vfs_path="-")


def operand_name(p: PathSpec) -> str:
    """The name ripgrep prints for an operand.

    ``-`` is ``<stdin>``. ``/dev/stdin`` reads the same bytes, but
    ripgrep opens it as the path it is and names it as typed.

    Args:
        p (PathSpec): the operand.
    """
    return STDIN_NAME if p.raw_path == "-" else p.raw_path


async def fifo_stat(path: str) -> FileStat:
    """A stdin operand's stat: a stream, never a directory to walk.

    Args:
        path (str): the operand's name.
    """
    return FileStat(name=path, type=FileType.FIFO)


async def selects_any(source: AsyncIterator[bytes], pat: re.Pattern[str],
                      invert: bool) -> bool:
    """Whether ``source`` selects a line, read no further than the first.

    The listing modes need only that one bit, so an unbounded pipe is
    never buffered whole to answer them.

    Args:
        source (AsyncIterator[bytes]): the input to probe.
        pat (re.Pattern[str]): the compiled pattern list.
        invert (bool): -v, select the lines that do not match.
    """
    probe = IOResult(exit_code=1)
    async for _ in grep_stream(source,
                               pat,
                               invert=invert,
                               max_count=1,
                               count_only=True,
                               io=probe):
        pass
    return probe.exit_code == 0


@dataclass(frozen=True, slots=True)
class RgFlags:
    """Parsed rg flags (TS RgFlags parity); the complete set rg honors."""
    ignore_case: bool
    invert: bool
    line_numbers: bool
    byte_offsets: bool
    count_only: bool
    files_only: bool
    files_without_match: bool
    whole_word: bool
    fixed_string: bool
    only_matching: bool
    with_filename: bool
    no_filename: bool
    hidden: bool
    file_type: str | None
    glob_pattern: str | None
    max_count: int | None
    context_after: int
    context_before: int


def parse_flags(fl: FlagView, never_match: bool) -> RgFlags:
    """Convert the raw flag bag into RgFlags, the only string-keyed reads.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        never_match (bool): zero-pattern sentinel from resolve_pattern; it is
            a regex, so it suppresses -F.
    """
    a_ctx = fl.as_int("A")
    b_ctx = fl.as_int("B")
    c_ctx = fl.as_int("C")
    context_after = a_ctx if a_ctx is not None else 0
    context_before = b_ctx if b_ctx is not None else 0
    if c_ctx is not None:
        # rg family: -C overrides -A/-B (grep keeps -A/-B precedence)
        context_before = context_after = c_ctx
    # -c, -l and --files-without-match set one output mode in ripgrep,
    # so the later one on the line wins: `-c --files-without-match`
    # lists the matchless files and `--files-without-match -c` prints
    # counts (ripgrep 14.1.1).
    listing: str | None = None
    for name in fl.typed_order("c", "args_l", "files_without_match"):
        if fl.as_bool(name):
            listing = name
    return RgFlags(
        ignore_case=fl.as_bool("i"),
        invert=fl.as_bool("v"),
        line_numbers=fl.as_bool("n"),
        byte_offsets=fl.as_bool("byte_offset"),
        count_only=listing == "c",
        files_only=listing == "args_l",
        files_without_match=listing == "files_without_match",
        whole_word=fl.as_bool("w"),
        fixed_string=fl.as_bool("F") and not never_match,
        only_matching=fl.as_bool("o"),
        with_filename=fl.as_bool("H"),
        no_filename=fl.as_bool("args_I"),
        hidden=fl.as_bool("hidden"),
        file_type=fl.as_str("type"),
        glob_pattern=fl.as_str("glob"),
        max_count=fl.as_int("m"),
        context_after=context_after,
        context_before=context_before,
    )


def prints_context(f: RgFlags) -> bool:
    """Whether the output shows -A/-B/-C context.

    Only printed lines carry it: -c, -l and --files-without-match answer
    per file, and -o drops it (ripgrep prints -o's context its own way).

    Args:
        f (RgFlags): the parsed flags.
    """
    if f.count_only or f.files_only or f.files_without_match:
        return False
    return bool(f.context_before or f.context_after) and not f.only_matching


async def stream_hits(source: AsyncIterator[bytes],
                      pat: re.Pattern[str],
                      f: RgFlags,
                      io: IOResult,
                      label: str | None = None) -> list[str]:
    """One input's records, scanned as it streams.

    ``grep_stream`` stops reading at -m's last selected line and that
    line's trailing context, so a pipe that goes on past the answer is
    never waited on, and only what it prints is held.

    Args:
        source (AsyncIterator[bytes]): the input's bytes.
        pat (re.Pattern[str]): the compiled pattern list.
        f (RgFlags): the parsed flags.
        io (IOResult): receives exit status 0 once a line is selected.
        label (str | None): the name each printed line leads with; a -c
            count is left for the caller to name.
    """
    printed = await materialize(
        grep_stream(source,
                    pat,
                    invert=f.invert,
                    line_numbers=f.line_numbers,
                    only_matching=f.only_matching,
                    max_count=f.max_count,
                    count_only=f.count_only,
                    after_context=f.context_after,
                    before_context=f.context_before,
                    io=io,
                    byte_offsets=f.byte_offsets,
                    context_label=label,
                    trailing_matches=True))
    hits = split_lines(decode_line(printed))
    if label is None or f.count_only or prints_context(f):
        # The context renderer leads each line with the label itself.
        return hits
    return [f"{label}:{hit}" for hit in hits]


async def operand_records(source: AsyncIterator[bytes], name: str,
                          pat: re.Pattern[str], f: RgFlags, label: bool,
                          io: IOResult) -> list[str]:
    """A stdin operand's records in the full-scan branch, never read whole.

    -l and --files-without-match are settled at the first selected line
    and -m at its last one. ripgrep searches stdin whatever --type or
    --glob say, since it never filters an explicit operand.

    Args:
        source (AsyncIterator[bytes]): the operand's turn on stdin.
        name (str): the name the operand's records carry.
        pat (re.Pattern[str]): the compiled pattern list.
        f (RgFlags): the parsed flags.
        label (bool): prefix each record with ``name``.
        io (IOResult): receives exit status 0 once a line is selected.
    """
    if f.files_only or f.files_without_match:
        # -m0 reads nothing at all.
        if f.max_count == 0:
            return []
        hit = await selects_any(source, pat, f.invert)
        if hit:
            io.exit_code = 0
        # -l lists a stdin that selected a line, --files-without-match one
        # that selected none.
        return [name] if hit == f.files_only else []
    scanned = IOResult(exit_code=1)
    hits = await stream_hits(source, pat, f, scanned, name if label else None)
    if scanned.exit_code == 0:
        io.exit_code = 0
    if f.count_only:
        # grep_stream prints a zero count; ripgrep lists nothing for it.
        if not grep_count_has_matches(hits):
            return []
        return [f"{name}:{hits[0]}" if label else hits[0]]
    return hits


async def rg(
    paths: list[PathSpec],
    texts: Sequence[str],
    opts: CommandOpts,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run ripgrep-style fallback search over backend paths or stdin.

    Interprets the flags itself (TS rgGeneric parity), so backend
    wrappers only wire paths, texts, the bag, and backend I/O.

    Args:
        paths (list[PathSpec]): Backend paths to search. Empty searches
            stdin as an implicit ``-``.
        texts (Sequence[str]): positional TEXT operands (the pattern unless
            -e/-f supplied it).
        opts (CommandOpts): the invocation bag, read for the raw flag
            kwargs and for the mount boundaries. The whole bag rather
            than the two facts, so a wrapper cannot pass one and
            forget the other: sixteen of this generic's nineteen call
            sites omitted the boundaries when they were a keyword of
            their own, which turned the mount-parent wrappers off on
            every bespoke backend. Mirrors TS, whose generic has
            always taken ``opts`` and read the boundaries off it.
        readdir (Callable[..., Awaitable[list[str]]]): Directory reader.
        stat (Callable[[PathSpec], Awaitable[FileStat]]): Backend stat reader.
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader.
        read_stream (Callable[..., AsyncIterator[bytes]] | None): Optional
            stream reader.
        stdin (ByteSource | None): the invocation's input, which a ``-``
            operand reads, as does a line with no operand at all.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    read_bytes = cache_aware_bound_bytes(read_bytes)
    if read_stream is not None:
        read_stream = cache_aware_bound_stream(read_stream)
    # Every `-` operand reads stdin through one cursor, as grep's do. With
    # no operand typed, the implicit one below is stdin's sole reader, so a
    # search that stops early closes the input.
    operand_stream = stdin_stream(
        read_stream if read_stream is not None else read_bytes,
        stdin,
        sole=not paths)
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern, never_match = await resolve_pattern(texts, fl, read_bytes,
                                                 RG_NO_PATTERN)
    f = parse_flags(fl, never_match)

    if not paths:
        # A line that names no path searches a piped stdin as an
        # implicit `-` operand, so -l, -H, -c and context answer as they
        # do for a typed one (ripgrep's Paths::from_low_args, 14.1.1).
        if stdin is None:
            raise UsageError(RG_NO_PATTERN)
        paths = [IMPLICIT_STDIN]

    mounts = opts.ns.mounts if opts.ns is not None else None
    mount_prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    rd = mount_parent_readdir(
        partial(call_readdir, readdir, prefix=mount_prefix), mounts)
    st = mount_parent_stat(partial(call_stat, stat, prefix=mount_prefix),
                           mounts)
    rb = partial(call_read_bytes, read_bytes, prefix=mount_prefix)

    # ripgrep labels when searching multiple files; -H forces the label
    # for a single file and -I suppresses it (cross-mount fanout forces
    # -H so per-operand native runs stay filename-keyed).
    label = (len(paths) > 1 or f.with_filename) and not f.no_filename
    needs_full = bool(f.files_only or f.files_without_match or f.context_before
                      or f.context_after or f.file_type or f.glob_pattern)
    unreadable: BaseException | None = None
    # Every operand is probed, not just the first: a directory anywhere on
    # the line is walked, as ripgrep walks `rg x file dir`.
    for p in paths:
        if needs_full:
            break
        try:
            s = await (fifo_stat(p.raw_path) if is_stdin(p) else st(p.virtual))
            needs_full = s.type == FileType.DIRECTORY
        except WALK_ERRORS as exc:
            try:
                await rd(p.virtual)
                needs_full = True
            except WALK_ERRORS:
                # Neither statable nor listable: carry the error, which
                # the single-operand path below reports as ripgrep's own
                # rather than letting the shared handler flatten it to
                # exit 1.
                unreadable = exc
    pat = compile_pattern(pattern, f.ignore_case, f.fixed_string, f.whole_word)
    if needs_full:
        warnings_f: list[str] = []
        results: list[str] = []
        # Status comes from selection, not from the printed lines:
        # under -o a zero-width match selects the line and prints
        # nothing, so an empty `results` is not "nothing matched".
        # `grep -r` reads its status the same way.
        full_io = IOResult(exit_code=1)
        # ripgrep puts `--` between one operand's context and the next
        # one's, labelled or not.
        context = prints_context(f)
        for p in paths:
            if is_stdin(p):
                records = await operand_records(operand_stream(p),
                                                operand_name(p), pat, f, label,
                                                full_io)
            else:
                hits_full = await rg_full(
                    rd,
                    st,
                    rb,
                    p.virtual,
                    pattern,
                    ignore_case=f.ignore_case,
                    invert=f.invert,
                    line_numbers=f.line_numbers,
                    count_only=f.count_only,
                    files_only=f.files_only,
                    files_without_match=f.files_without_match,
                    fixed_string=f.fixed_string,
                    only_matching=f.only_matching,
                    max_count=f.max_count,
                    whole_word=f.whole_word,
                    context_before=f.context_before,
                    context_after=f.context_after,
                    file_type=f.file_type,
                    glob_pattern=f.glob_pattern,
                    hidden=f.hidden,
                    warnings=warnings_f,
                    file_prefix=p.raw_path if label else None,
                    no_filename=f.no_filename,
                    byte_offsets=f.byte_offsets,
                    io=full_io,
                )
                records = respell_raw(hits_full, p.virtual, p.raw_path)
            if context and results and records:
                results.append("--")
            results.extend(records)
        stderr = format_optional_records(warnings_f)
        # ripgrep's status under --files-without-match follows the
        # listing, not the matching: 0 when a file was listed, 1 when
        # every file matched (14.1.1; GNU grep keeps the match status).
        selected = (bool(results) if f.files_without_match and not f.count_only
                    else full_io.exit_code == 0)
        code = exit_code_for(selected, bool(warnings_f), False)
        if not results:
            return b"", IOResult(exit_code=code, stderr=stderr)
        return format_records(results), IOResult(exit_code=code, stderr=stderr)

    if len(paths) > 1 or f.with_filename:
        all_results: list[str] = []
        warnings: list[str] = []
        # Status comes from selection, not from the printed lines:
        # with -o a zero-width match selects the line and prints
        # nothing, so `all_results` is no longer a proxy for
        # "nothing matched". Same per-file IOResult that
        # `grep_generic` reads selection off.
        matched = False
        for p in paths:
            file_io = IOResult(exit_code=1)
            name = operand_name(p)
            if is_stdin(p):
                # Streamed, so -m stops reading a pipe at its answer.
                hits = await stream_hits(operand_stream(p), pat, f, file_io)
            else:
                try:
                    raw = await rb(p.virtual)
                except FS_ERRORS as exc:
                    # ripgrep reports the failed operand and keeps
                    # searching the rest.
                    warnings.append(f"rg: {p.raw_path}: {fs_strerror(exc)}")
                    continue
                # `decode_line`, not a replacing decode: `grep_lines`
                # counts its -b offsets back out of this text, and one
                # invalid byte read as U+FFFD is three bytes wide
                # there, so `rg -b a f1 f2` over `\xff\na\n` answered 4
                # where GNU and the single-operand path (which counts
                # raw bytes in `grep_stream`) both say 2.
                data = split_lines(decode_line(raw))
                hits = grep_lines(name, data, pat, f.invert, f.line_numbers,
                                  f.count_only, f.files_only, f.only_matching,
                                  f.max_count, file_io, f.byte_offsets)
            matched = matched or file_io.exit_code == 0
            if f.count_only:
                if grep_count_has_matches(hits):
                    all_results.append(
                        f"{name}:{hits[0]}" if label else hits[0])
            elif f.files_only:
                all_results.extend(hits)
            elif label:
                all_results.extend(f"{name}:{r}" for r in hits)
            else:
                all_results.extend(hits)
        stderr = format_optional_records(warnings)
        code = exit_code_for(matched, bool(warnings), False)
        if not all_results:
            return b"", IOResult(exit_code=code, stderr=stderr)
        return format_records(all_results), IOResult(exit_code=code,
                                                     stderr=stderr)

    if unreadable is not None:
        stderr = (f"rg: {paths[0].raw_path}: "
                  f"{fs_strerror(unreadable)}\n").encode()
        return b"", IOResult(exit_code=2, stderr=stderr)

    if is_stdin(paths[0]):
        source: AsyncIterator[bytes] = operand_stream(paths[0])
    elif read_stream is not None:
        source = read_stream(paths[0])
    else:
        raw_bytes = await rb(paths[0].virtual)
        source = _wrap_bytes(raw_bytes)
    # Status comes from selection, not from an empty stream: with -o
    # a zero-width match selects the line and prints nothing, so
    # emptiness is no longer a proxy for "nothing matched".
    io = IOResult(exit_code=1)
    stream = grep_stream(
        source,
        pat,
        invert=f.invert,
        line_numbers=f.line_numbers,
        only_matching=f.only_matching,
        max_count=f.max_count,
        count_only=f.count_only,
        io=io,
        byte_offsets=f.byte_offsets,
    )
    if f.count_only:
        stream = nonzero_count_stream(stream)
    return stream, io


async def _wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


__all__ = ["rg"]


def labelled(opts: CommandOpts) -> CommandOpts:
    """Ask for the filename a walk would have printed on its own.

    A content search hands the generic explicit files where the user
    named a directory, and the generic labels explicit operands only when
    there are several, so ``-H`` is requested here; an explicit ``-I``
    still wins, since forcing ``-H`` under it would defeat the suppression
    in the delegated scan.

    Args:
        opts (CommandOpts): the narrowing wrapper's options.
    """
    flags = opts.flags or {}
    if FlagView(flags, spec=SPECS["rg"]).as_bool("args_I"):
        return opts
    return replace(opts, flags={**flags, "H": True})
