# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import posixpath
import re

from mirage.commands.builtin.constants import BINARY_EXTENSIONS
from mirage.commands.builtin.grep_context import grep_context_lines
from mirage.commands.builtin.grep_offsets import (decode_line, line_offsets,
                                                  match_offset, prefix_of)
from mirage.commands.builtin.grep_pattern import compile_pattern
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.types import (AsyncReadBytes, AsyncReaddir,
                                                 AsyncStat)
from mirage.commands.resolve import get_extension
from mirage.io.types import IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.errors import WALK_ERRORS, fs_strerror
from mirage.utils.fnmatch import fnmatch

_TYPE_EXTENSIONS: dict[str, list[str]] = {
    "py": [".py"],
    "js": [".js", ".jsx"],
    "ts": [".ts", ".tsx"],
    "java": [".java"],
    "go": [".go"],
    "rs": [".rs"],
    "rb": [".rb"],
    "c": [".c", ".h"],
    "cpp": [".cpp", ".hpp", ".cc", ".cxx"],
    "css": [".css"],
    "html": [".html", ".htm"],
    "json": [".json"],
    "yaml": [".yaml", ".yml"],
    "toml": [".toml"],
    "md": [".md"],
    "txt": [".txt"],
    "xml": [".xml"],
    "sql": [".sql"],
    "sh": [".sh", ".bash"],
    "csv": [".csv"],
}


def _rg_matches_filter(
    entry: str,
    file_type: str | None,
    glob_pattern: str | None,
    hidden: bool,
) -> bool:
    basename = posixpath.basename(entry)
    if not hidden and basename.startswith("."):
        return False
    if file_type is not None:
        exts = _TYPE_EXTENSIONS.get(file_type, [f".{file_type}"])
        if not any(entry.endswith(ext) for ext in exts):
            return False
    if glob_pattern is not None and not fnmatch(basename, glob_pattern):
        return False
    return True


def walk_candidates(candidates: list[PathSpec], scopes: list[PathSpec],
                    file_type: str | None, glob_pattern: str | None,
                    hidden: bool) -> list[PathSpec]:
    """The candidates a walk of ``scopes`` would have searched.

    A search push-down narrows a directory search to candidate files and
    hands them on as operands of their own, which ripgrep never filters,
    so the walk's filters are applied here instead: no dot segment below
    the candidate's (longest-matching) scope unless --hidden, since the
    walk never descends into a hidden directory, and --type and --glob on
    the file itself.

    Args:
        candidates (list[PathSpec]): the narrowed candidate files.
        scopes (list[PathSpec]): the operands the search narrowed.
        file_type (str | None): --type, restrict by extension set.
        glob_pattern (str | None): --glob, restrict by basename glob.
        hidden (bool): --hidden, keep dot entries.
    """
    kept: list[PathSpec] = []
    for p in candidates:
        rel = p.virtual
        best = -1
        for scope in scopes:
            base = scope.virtual.rstrip("/")
            if len(base) > best and (p.virtual == base
                                     or p.virtual.startswith(base + "/")):
                rel = p.virtual[len(base):]
                best = len(base)
        if not hidden and any(
                seg.startswith(".") for seg in rel.split("/") if seg):
            continue
        if not _rg_matches_filter(p.virtual, file_type, glob_pattern, True):
            continue
        kept.append(p)
    return kept


def search_file(
    path: str,
    data: list[str],
    compiled: re.Pattern[str],
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    only_matching: bool,
    max_count: int | None,
    context: bool,
    context_before: int,
    context_after: int,
    prefix_path: str | None,
    byte_offsets: bool,
    files_without_match: bool,
    io: IOResult | None,
) -> list[str]:
    """Search one already-read file, returning the lines ripgrep prints.

    Args:
        path (str): the file, answered by --files-without-match.
        data (list[str]): its lines, from ``decode_line``.
        compiled (re.Pattern[str]): the compiled pattern.
        invert (bool): -v, select the lines that do not match.
        line_numbers (bool): -n, prefix each line with its number.
        count_only (bool): -c, answer with the count.
        files_only (bool): -l, answer with the name.
        only_matching (bool): -o, print the matched text.
        max_count (int | None): -m, stop after this many selected lines.
        context (bool): the output shows context, see ``rg_full``.
        context_before (int): -B, leading context lines.
        context_after (int): -A, trailing context lines.
        prefix_path (str | None): the label every printed line leads with
            and the name -l answers with; None prints bare lines.
        byte_offsets (bool): -b, prefix each line with the byte offset of
            its own start, or of the match itself under -o.
        files_without_match (bool): --files-without-match, which -c
            outranks.
        io (IOResult | None): receives exit status 0 as soon as a line
            is selected, see ``rg_full``.
    """
    if max_count == 0:
        # ripgrep and GNU both select no line at all under -m0 and print
        # nothing, count included; read before the scan because
        # `count >= 0` is already true further down.
        return []
    without_match = files_without_match and not count_only
    if context:
        # Context rides the shared renderer: match lines `N:`, context
        # lines `N-`, `--` between groups, all led by the label when the
        # search prints one, and a trailing line that would be selected
        # past -m printed as selected, as ripgrep prints it.
        rendered = grep_context_lines(data,
                                      compiled,
                                      invert,
                                      line_numbers,
                                      max_count,
                                      context_after,
                                      context_before,
                                      byte_offsets,
                                      prefix_path,
                                      trailing_matches=True)
        if rendered and io is not None:
            io.exit_code = 0
        # `decode_line` because the renderer puts a smuggled byte back as
        # itself, and `format_records` puts it out as itself too.
        return [decode_line(b).rstrip("\n") for b in rendered]
    results: list[str] = []
    count = 0
    offsets = line_offsets(data) if byte_offsets else []
    for i_ln, line in enumerate(data, 1):
        start = offsets[i_ln - 1] if byte_offsets else 0
        matched = bool(compiled.search(line)) != invert
        if not matched:
            continue
        count += 1
        if io is not None:
            io.exit_code = 0
        if files_only:
            return [prefix_path if prefix_path is not None else path]
        if without_match:
            return []
        if only_matching:
            # GNU -o prints every match on the line, one per line, and
            # prints nothing at all for an empty match nor for an
            # inverted selection, which has no match to print -- but the
            # line is still selected, so `count` is already incremented
            # above and -c, -l and the exit status see it. Mirrors
            # `searchFile` in rg_scan.ts and `grep_lines` in grep_scan.py.
            if not invert:
                for found in compiled.finditer(line):
                    text = found.group(0)
                    if not text:
                        continue
                    one = prefix_of(
                        i_ln if line_numbers else None,
                        match_offset(start, line, found.start())
                        if byte_offsets else None) + text
                    results.append(f"{prefix_path}:{one}"
                                   if prefix_path is not None else one)
        else:
            one = (prefix_of(i_ln if line_numbers else None,
                             start if byte_offsets else None) + line)
            results.append(
                f"{prefix_path}:{one}" if prefix_path is not None else one)
        if max_count is not None and count >= max_count:
            # -m is per file in a walk, as ripgrep's is (`rg -m1 a dir`
            # prints one line per file on ripgrep 14.1.0).
            break
    if count_only:
        if count == 0:
            return []
        return [
            f"{prefix_path}:{count}" if prefix_path is not None else str(count)
        ]
    if without_match:
        return [path]
    return results


async def rg_full(
    readdir_fn: AsyncReaddir,
    stat_fn: AsyncStat,
    read_bytes_fn: AsyncReadBytes,
    path: str,
    pattern: str,
    ignore_case: bool,
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    fixed_string: bool,
    only_matching: bool,
    max_count: int | None,
    whole_word: bool,
    context_before: int,
    context_after: int,
    file_type: str | None,
    glob_pattern: str | None,
    hidden: bool,
    warnings: list[str] | None,
    file_prefix: str | None = None,
    no_filename: bool = False,
    byte_offsets: bool = False,
    io: IOResult | None = None,
    files_without_match: bool = False,
) -> list[str]:
    """Search one operand, returning the lines ripgrep would print.

    Args:
        readdir_fn (AsyncReaddir): backend directory reader.
        stat_fn (AsyncStat): backend stat reader.
        read_bytes_fn (AsyncReadBytes): whole-file reader.
        path (str): the operand to search.
        pattern (str): the pattern text.
        ignore_case (bool): -i, case-insensitive matching.
        invert (bool): -v, select the lines that do not match.
        line_numbers (bool): -n, prefix each line with its number.
        count_only (bool): -c, answer with per-file counts.
        files_only (bool): -l, answer with the paths that matched.
        fixed_string (bool): -F, read the pattern literally.
        only_matching (bool): -o, print the matched text.
        max_count (int | None): -m, stop after this many selected lines.
        whole_word (bool): -w, match whole words.
        context_before (int): -B, leading context lines.
        context_after (int): -A, trailing context lines.
        file_type (str | None): --type, restrict by extension set.
        glob_pattern (str | None): --glob, restrict by basename glob.
        hidden (bool): --hidden, walk dot-entries too.
        warnings (list[str] | None): collects per-operand errors.
        file_prefix (str | None): the label a single-file run carries.
        no_filename (bool): -I, drop per-file labels in a walk.
        byte_offsets (bool): -b, prefix each line with the byte offset of
            its own start, or of the match itself under -o.
        files_without_match (bool): --files-without-match, answer with the
            paths that selected NO line. ``-c`` outranks it, as it does
            in ripgrep (``rg --files-without-match -c`` prints counts).
        io (IOResult | None): when given, receives exit status 0 as soon
            as a line is selected. Selection cannot be read off the
            returned list: under -o a zero-width match selects the line
            and prints nothing, so a caller deriving the status from an
            empty list reports 1 where GNU says 0. The twin of the
            channel ``grep_lines`` and ``grep_stream`` already take, and
            `grep -r` is the reference.
    """
    compiled = compile_pattern(pattern, ignore_case, fixed_string, whole_word)
    # Only printed lines carry context: -c, -l and --files-without-match
    # answer per file, and -o drops it (ripgrep prints -o's context its
    # own way).
    context = bool(context_before or context_after) and not (
        count_only or files_only or files_without_match or only_matching)

    is_dir = False
    try:
        s = await stat_fn(path)
        is_dir = s.type == FileType.DIRECTORY
    except WALK_ERRORS:
        try:
            await readdir_fn(path)
            is_dir = True
        except WALK_ERRORS:
            # not a directory (or vanished): treat the operand as a file
            pass

    if not is_dir:
        # ripgrep searches a file named on the line whatever --type,
        # --glob or a leading dot say: its walker filters no entry at
        # depth 0. A push-down that narrows a walk filters its candidates
        # itself (``walk_candidates``).
        try:
            data = split_lines(decode_line(await read_bytes_fn(path)))
        except WALK_ERRORS as exc:
            if warnings is not None:
                warnings.append(f"rg: {path}: {fs_strerror(exc) or exc}")
            return []
        return search_file(path, data, compiled, invert, line_numbers,
                           count_only, files_only, only_matching, max_count,
                           context, context_before, context_after, file_prefix,
                           byte_offsets, files_without_match, io)

    results: list[str] = []
    try:
        entries = await readdir_fn(path)
    except WALK_ERRORS as exc:
        if warnings is not None:
            warnings.append(f"rg: {path}: {fs_strerror(exc) or exc}")
        return results

    for entry in entries:
        try:
            s = await stat_fn(entry)
        except WALK_ERRORS as exc:
            if warnings is not None:
                warnings.append(f"rg: {entry}: {fs_strerror(exc) or exc}")
            continue

        if s.type == FileType.DIRECTORY:
            basename = posixpath.basename(entry)
            if not hidden and basename.startswith("."):
                continue
            found = await rg_full(
                readdir_fn,
                stat_fn,
                read_bytes_fn,
                entry,
                pattern,
                ignore_case,
                invert,
                line_numbers,
                count_only,
                files_only,
                fixed_string,
                only_matching,
                max_count,
                whole_word,
                context_before,
                context_after,
                file_type,
                glob_pattern,
                hidden,
                warnings,
                no_filename=no_filename,
                byte_offsets=byte_offsets,
                io=io,
                files_without_match=files_without_match,
            )
        elif s.type is FileType.FILE:
            if get_extension(entry) in BINARY_EXTENSIONS:
                continue
            if not _rg_matches_filter(entry, file_type, glob_pattern, hidden):
                continue
            try:
                data = split_lines(decode_line(await read_bytes_fn(entry)))
            except WALK_ERRORS as exc:
                if warnings is not None:
                    warnings.append(f"rg: {entry}: {fs_strerror(exc) or exc}")
                continue
            # ripgrep -I drops per-file labels in directory walks; -l
            # keeps paths (they are the output).
            label = None if no_filename and not files_only else entry
            found = search_file(entry, data, compiled, invert, line_numbers,
                                count_only, files_only, only_matching,
                                max_count, context, context_before,
                                context_after, label, byte_offsets,
                                files_without_match, io)
        else:
            continue
        # ripgrep puts `--` between one file's context and the next
        # file's, labelled or not.
        if context and results and found:
            results.append("--")
        results.extend(found)

    return results
