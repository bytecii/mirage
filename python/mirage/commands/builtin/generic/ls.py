from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.formatting import format_ls_long
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, LsSortBy, PathSpec
from mirage.utils.errors import fs_strerror
from mirage.utils.key_prefix import rekey
from mirage.utils.path import rebase_one

Readdir = Callable[[PathSpec, IndexCacheStore | None], Awaitable[list[str]]]
Stat = Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]]


@dataclass(frozen=True, slots=True)
class Operand:
    """One ls operand once its kind is known.

    ``row`` is set when the operand is not a directory: GNU prints those
    first, as one block with no header. ``groups`` holds one
    ``(dir, entries)`` pair per directory listed under the operand — one
    for a plain listing, the whole pre-order subtree under ``-R``. Both
    empty means the operand could not be accessed.
    """
    path: PathSpec
    row: FileStat | None
    groups: list[tuple[PathSpec, list[FileStat]]]


def format_simple(entries: list[FileStat],
                  *,
                  classify: bool = False) -> list[str]:
    out: list[str] = []
    for e in entries:
        is_dir = classify and e.type == FileType.DIRECTORY
        out.append(e.name + "/" if is_dir else e.name)
    return out


def _sort_value(entry: FileStat, sort_by: LsSortBy) -> str | int:
    if sort_by is LsSortBy.TIME:
        return entry.modified or ""
    if sort_by is LsSortBy.SIZE:
        return entry.size or 0
    return entry.name


def _descending(sort_by: LsSortBy, reverse: bool) -> bool:
    # -t and -S list newest/largest first, so -r flips them back to last.
    return reverse if sort_by is LsSortBy.NAME else not reverse


def sort_stats(entries: list[FileStat], sort_by: LsSortBy,
               reverse: bool) -> list[FileStat]:
    return sorted(entries,
                  key=lambda s: _sort_value(s, sort_by),
                  reverse=_descending(sort_by, reverse))


async def _file_entry(
    path: PathSpec,
    stat: Stat,
    index: IndexCacheStore,
) -> FileStat | None:
    try:
        s = await stat(path, index)
    except (FileNotFoundError, ValueError):
        return None
    if s.type == FileType.DIRECTORY:
        return None
    # GNU ls prints a file operand as given (`ls sub/x.txt` shows
    # sub/x.txt, not x.txt); the row carries the operand spelling.
    return s.model_copy(update={"name": path.raw_path})


def _child_spec(path: PathSpec, name: str) -> PathSpec:
    child = path.child(name)
    return PathSpec(virtual=child,
                    directory=child,
                    resolved=False,
                    resource_path=rekey(path.virtual, path.resource_path,
                                        child))


async def _stat_entries(
    path: PathSpec,
    names: list[str],
    *,
    stat: Stat,
    all_files: bool,
    index: IndexCacheStore,
) -> tuple[list[FileStat], list[str]]:
    stats: list[FileStat] = []
    warnings: list[str] = []
    for entry in names:
        entry_spec = PathSpec(virtual=entry,
                              directory=entry,
                              resolved=False,
                              resource_path=rekey(path.virtual,
                                                  path.resource_path, entry))
        try:
            s = await stat(entry_spec, index)
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(
                f"ls: cannot access '{entry}': {fs_strerror(exc) or exc}")
            continue
        if not all_files and s.name.startswith("."):
            continue
        stats.append(s)
    return stats, warnings


async def probe_operand(
    path: PathSpec,
    *,
    readdir: Readdir,
    stat: Stat,
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[Operand, list[str]]:
    """List one operand and report whether it turned out to be a directory.

    Args:
        path (PathSpec): the operand to list.
        readdir (Readdir): backend directory lister.
        stat (Stat): backend stat.
        all_files (bool): keep dotfiles.
        sort_by (LsSortBy): active sort key.
        reverse (bool): reverse the sort.
        recursive (bool): descend, emitting one group per directory (-R).
        index (IndexCacheStore): listing cache.
    """
    warnings: list[str] = []
    try:
        names = await readdir(path, index)
    except (FileNotFoundError, ValueError, NotADirectoryError) as exc:
        row = await _file_entry(path, stat, index)
        if row is not None:
            return Operand(path, row, []), warnings
        warnings.append(
            f"ls: cannot access '{path.raw_path}': {fs_strerror(exc) or exc}")
        return Operand(path, None, []), warnings

    if not names:
        row = await _file_entry(path, stat, index)
        if row is not None:
            return Operand(path, row, []), warnings

    entries, entry_ws = await _stat_entries(path,
                                            names,
                                            stat=stat,
                                            all_files=all_files,
                                            index=index)
    warnings.extend(entry_ws)
    entries = sort_stats(entries, sort_by, reverse)
    groups: list[tuple[PathSpec, list[FileStat]]] = [(path, entries)]
    if recursive:
        for entry in entries:
            if entry.type != FileType.DIRECTORY:
                continue
            child, child_ws = await probe_operand(_child_spec(
                path, entry.name),
                                                  readdir=readdir,
                                                  stat=stat,
                                                  all_files=all_files,
                                                  sort_by=sort_by,
                                                  reverse=reverse,
                                                  recursive=True,
                                                  index=index)
            groups.extend(child.groups)
            warnings.extend(child_ws)
    return Operand(path, None, groups), warnings


async def walk(
    path: PathSpec,
    *,
    readdir: Readdir,
    stat: Stat,
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[list[FileStat], list[str]]:
    """Flat listing for one operand: a directory's entries, or the operand
    itself when it is not one. ``recursive`` flattens the whole subtree in
    ``ls -R`` order.

    Args:
        path (PathSpec): the operand to list.
        readdir (Readdir): backend directory lister.
        stat (Stat): backend stat.
        all_files (bool): keep dotfiles.
        sort_by (LsSortBy): active sort key.
        reverse (bool): reverse the sort.
        recursive (bool): descend into subdirectories.
        list_dir (bool): stat the operand itself instead of listing it (-d).
        index (IndexCacheStore): listing cache.
    """
    if list_dir:
        try:
            listed = await stat(path, index)
        except (FileNotFoundError, ValueError) as exc:
            detail = fs_strerror(exc) or exc
            return [], [f"ls: cannot access '{path.raw_path}': {detail}"]
        # GNU ls -d prints the operand as given.
        return [listed.model_copy(update={"name": path.raw_path})], []

    operand, warnings = await probe_operand(path,
                                            readdir=readdir,
                                            stat=stat,
                                            all_files=all_files,
                                            sort_by=sort_by,
                                            reverse=reverse,
                                            recursive=recursive,
                                            index=index)
    if operand.row is not None:
        return [operand.row], warnings
    return [e for _, entries in operand.groups for e in entries], warnings


async def _operand_key(
    operand: Operand,
    *,
    sort_by: LsSortBy,
    stat: Stat,
    index: IndexCacheStore,
) -> FileStat:
    """Sort row for one operand, named with the operand's own spelling."""
    if operand.row is not None:
        return operand.row
    if sort_by is LsSortBy.NAME:
        return FileStat(name=operand.path.raw_path, type=FileType.DIRECTORY)
    try:
        s = await stat(operand.path, index)
    except (FileNotFoundError, ValueError):
        # The stat only supplies a sort key; an operand that cannot be
        # statted sorts as if it had none rather than failing the listing.
        return FileStat(name=operand.path.raw_path, type=FileType.DIRECTORY)
    return s.model_copy(update={"name": operand.path.raw_path})


async def _sorted_operands(
    operands: list[Operand],
    *,
    sort_by: LsSortBy,
    reverse: bool,
    stat: Stat,
    index: IndexCacheStore,
) -> list[Operand]:
    keyed = [(await _operand_key(o, sort_by=sort_by, stat=stat,
                                 index=index), o) for o in operands]
    keyed.sort(key=lambda pair: _sort_value(pair[0], sort_by),
               reverse=_descending(sort_by, reverse))
    return [o for _, o in keyed]


def _render_group(
    results: list[str],
    entries: list[FileStat],
    *,
    long: bool,
    one_per_line: bool,
    human: bool,
    classify: bool,
) -> None:
    if long and not one_per_line:
        results.extend(format_ls_long(entries, human=human))
    else:
        results.extend(format_simple(entries, classify=classify))


def _finish(results: list[str], warnings: list[str], *,
            listed: bool) -> tuple[bytes, IOResult]:
    # Exit 1 only when nothing could be listed at all; directory headers
    # are output, not evidence that an operand succeeded.
    exit_code = 1 if warnings and not listed else 0
    return format_records(results), IOResult(
        stderr=format_optional_records(warnings), exit_code=exit_code)


async def ls(
    paths: list[PathSpec],
    *,
    readdir: Readdir,
    stat: Stat,
    long: bool = False,
    one_per_line: bool = False,
    all_files: bool = False,
    human: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    classify: bool = False,
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[bytes, IOResult]:
    results: list[str] = []
    warnings: list[str] = []

    if list_dir:
        # -d turns every operand into a plain row, sorted together and
        # printed with no headers.
        rows: list[FileStat] = []
        for p in paths:
            entries, p_ws = await walk(p,
                                       readdir=readdir,
                                       stat=stat,
                                       list_dir=True,
                                       index=index)
            rows.extend(entries)
            warnings.extend(p_ws)
        if len(rows) > 1:
            rows = sort_stats(rows, sort_by, reverse)
        _render_group(results,
                      rows,
                      long=long,
                      one_per_line=one_per_line,
                      human=human,
                      classify=classify)
        return _finish(results, warnings, listed=bool(rows))

    operands: list[Operand] = []
    for p in paths:
        operand, p_ws = await probe_operand(p,
                                            readdir=readdir,
                                            stat=stat,
                                            all_files=all_files,
                                            sort_by=sort_by,
                                            reverse=reverse,
                                            recursive=recursive,
                                            index=index)
        warnings.extend(p_ws)
        operands.append(operand)
    if len(operands) > 1:
        operands = await _sorted_operands(operands,
                                          sort_by=sort_by,
                                          reverse=reverse,
                                          stat=stat,
                                          index=index)

    # GNU names every listed directory once there is more than one operand
    # (or under -R); a lone directory operand is listed bare.
    headed = recursive or len(paths) > 1
    rows = [o.row for o in operands if o.row is not None]
    _render_group(results,
                  rows,
                  long=long,
                  one_per_line=one_per_line,
                  human=human,
                  classify=classify)
    printed = bool(rows)
    for operand in operands:
        for dir_spec, entries in operand.groups:
            if headed:
                if printed:
                    results.append("")
                header = rebase_one(dir_spec.virtual, operand.path.virtual,
                                    operand.path.raw_path)
                results.append(f"{header}:")
            _render_group(results,
                          entries,
                          long=long,
                          one_per_line=one_per_line,
                          human=human,
                          classify=classify)
            printed = True

    listed = any(o.row is not None or o.groups for o in operands)
    return _finish(results, warnings, listed=listed)


__all__ = [
    "Operand",
    "format_simple",
    "ls",
    "probe_operand",
    "sort_stats",
    "walk",
]
