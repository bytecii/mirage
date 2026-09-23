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

from dataclasses import dataclass, replace
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.diff_tree import _similarity_score
from dulwich.objects import Blob, Commit, ObjectID, Tree
from dulwich.patch import write_object_diff
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.changes import pair_renames
from mirage.commands.cli.builtin.git.combined import combined_lines
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.summary import (diffstat, stat_table,
                                                     tree_entries)
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.spec.flag_view import FlagView
from mirage.runtime.types import DispatchFn


@dataclass(frozen=True, slots=True)
class DiffFlags:
    """One interpretation of Git diff options, shared by all tree readers."""
    name_only: bool = False
    name_status: bool = False
    stat: bool = False
    numstat: bool = False
    shortstat: bool = False
    summary: bool = False
    patch: bool = False
    no_patch: bool = False
    renames: int | None = None
    merge: str = 'off'
    raw: bool = False


def parse_diff_flags(fl: FlagView,
                     *,
                     default_patch: bool = True,
                     default_merge: str = 'off',
                     porcelain: bool = True,
                     default_renames: bool = True) -> DiffFlags:
    modes = [
        fl.as_bool(key) for key in ('name_only', 'name_status', 'stat',
                                    'numstat', 'shortstat', 'summary')
    ]
    rename = fl.raw('find_renames')
    threshold = None
    if rename is not None and rename is not False:
        threshold = 50
        if isinstance(rename, str) and rename:
            value = rename.removesuffix('%')
            try:
                threshold = int(value) if rename.endswith('%') else int(
                    float('0.' + value) * 100)
            except ValueError as exc:
                raise GitError(f'invalid similarity index {rename}') from exc
    elif porcelain and default_renames:
        threshold = 50
    if fl.as_bool('no_renames'):
        threshold = None
    merge = fl.as_str('diff_merges') or default_merge
    if fl.as_bool('m'):
        merge = 'separate'
    if fl.as_bool('c'):
        merge = 'combined'
    if fl.as_bool('cc'):
        merge = 'dense-combined'
    if porcelain and fl.as_bool('first_parent'):
        merge = 'first-parent'
    merge = {
        '0': 'off',
        '1': 'separate',
        'on': 'separate',
        'm': 'separate',
        'c': 'combined',
        'cc': 'dense-combined'
    }.get(merge, merge)
    if merge not in ('off', 'separate', 'combined', 'dense-combined',
                     'first-parent'):
        raise GitError(f'invalid value for --diff-merges: {merge}')
    patch = fl.as_bool("patch") or ((default_patch or fl.as_bool("cc") or
                                     (porcelain and fl.as_bool("c")))
                                    and not any(modes))
    return DiffFlags(name_only=modes[0],
                     name_status=modes[1],
                     stat=modes[2],
                     numstat=modes[3],
                     shortstat=modes[4],
                     summary=modes[5],
                     patch=patch,
                     no_patch=fl.as_bool('no_patch'),
                     renames=threshold,
                     merge=merge,
                     raw=not default_patch and not any(modes) and not patch)


@dataclass(frozen=True, slots=True)
class Change:
    """A paired tree delta; every output format consumes these same rows."""
    path: bytes
    old_path: bytes
    old: tuple[int, bytes] | None
    new: tuple[int, bytes] | None
    status: str
    score: int = 0


def compare(repo: BaseRepo, before: dict[bytes, tuple[int, bytes]],
            after: dict[bytes, tuple[int, bytes]],
            threshold: int | None) -> list[Change]:
    changed = sorted(p for p in set(before) | set(after)
                     if before.get(p) != after.get(p))
    codes = {
        p.decode(): ('A' if p not in before else
                     'D' if p not in after else 'T' if before[p][0]
                     & 0o170000 != after[p][0] & 0o170000 else 'M')
        for p in changed
    }
    entries = {p.decode(): after.get(p, before.get(p)) for p in changed}
    pairs = {
        p: (code, None)
        for p, code in codes.items()
    } if threshold is None else pair_renames(repo.object_store, codes, {
        p: e[1]
        for p, e in entries.items() if e is not None
    }, {
        p: e[0] & 0o170000
        for p, e in entries.items() if e is not None
    }, threshold)
    rows = []
    for path, (status, origin) in sorted(pairs.items()):
        name, old_path = path.encode(), (origin or path).encode()
        old, new = before.get(old_path), after.get(name)
        score = 0
        if origin is not None and old is not None and new is not None:
            score = 100 if old[1] == new[1] else _similarity_score(
                repo.object_store[ObjectID(old[1])],
                repo.object_store[ObjectID(new[1])])
        rows.append(Change(name, old_path, old, new, status, score))
    return rows


def rename_name(old: str, new: str) -> str:
    a, b = old.split('/'), new.split('/')
    prefix = []
    while len(a) > 1 and len(b) > 1 and a[0] == b[0]:
        prefix.append(a.pop(0))
        b.pop(0)
    suffix: list[str] = []
    while len(a) > 1 and len(b) > 1 and a[-1] == b[-1]:
        suffix.insert(0, a.pop())
        b.pop()
    middle = '/'.join(a) + ' => ' + '/'.join(b)
    return '/'.join([*prefix, '{' + middle +
                     '}', *suffix]) if prefix or suffix else middle


def render_changes(repo: BaseRepo, rows: list[Change],
                   flags: DiffFlags) -> bytes:
    if flags.no_patch:
        return b''
    lines = []
    stats = []
    numbers: list[str] = []
    summaries: list[str] = []
    patches = BytesIO()
    for row in rows:
        name, origin = row.path.decode(), row.old_path.decode()
        status = f'R{row.score:03d}' if row.status == 'R' else row.status
        paths = f'{origin}\t{name}' if row.status == 'R' else name
        if flags.name_only:
            lines.append(name)
        elif flags.name_status:
            lines.append(f'{status}\t{paths}')
        elif flags.raw:
            oldmode, oldid = row.old or (0, b'0' * 40)
            newmode, newid = row.new or (0, b'0' * 40)
            lines.append(f':{oldmode:06o} {newmode:06o} {oldid.decode()} '
                         f'{newid.decode()} {status}\t{paths}')
        else:
            before = {row.path: row.old} if row.old else {}
            after = {row.path: row.new} if row.new else {}
            counted = diffstat(repo.object_store, before, after)
            display = rename_name(origin, name) if row.status == 'R' else name
            if counted:
                stats.append(replace(counted[0], path=display))
            else:
                # An unchanged blob at a new name still needs a diffstat row.
                from_stat = diffstat(repo.object_store, {}, after)[0]
                stats.append(
                    replace(from_stat,
                            path=display,
                            insertions=0,
                            deletions=0,
                            old_size=from_stat.new_size))
            if flags.numstat:
                stat = stats[-1]
                counts = ("-\t-" if stat.binary else
                          f"{stat.insertions}\t{stat.deletions}")
                numbers.append(f'{counts}\t{display}')
            if flags.summary:
                if row.status == 'R':
                    summaries.append(f' rename {display} ({row.score}%)')
                elif row.old is None and row.new:
                    summaries.append(f' create mode {row.new[0]:06o} {name}')
                elif row.new is None and row.old:
                    summaries.append(f' delete mode {row.old[0]:06o} {name}')
                elif row.old and row.new and row.old[0] != row.new[0]:
                    summaries.append(f' mode change {row.old[0]:06o} => '
                                     f'{row.new[0]:06o} {name}')
            if flags.patch:
                if row.old and row.new and row.old[1] == row.new[
                        1] and row.status != 'R':
                    patches.write((f'diff --git a/{origin} b/{name}\n'
                                   f'old mode {row.old[0]:06o}\n'
                                   f'new mode {row.new[0]:06o}\n').encode())
                    continue
                if row.status == 'R':
                    patches.write(
                        (f'diff --git a/{origin} b/{name}\n'
                         f'similarity index {row.score}%\n'
                         f'rename from {origin}\nrename to {name}\n').encode())
                    if row.old == row.new:
                        continue
                patch = BytesIO()
                write_object_diff(patch, repo.object_store,
                                  (row.old_path if row.old else None,
                                   row.old[0] if row.old else None,
                                   ObjectID(row.old[1]) if row.old else None),
                                  (row.path if row.new else None,
                                   row.new[0] if row.new else None,
                                   ObjectID(row.new[1]) if row.new else None))
                data = patch.getvalue()
                if row.old and row.new and row.old[0] != row.new[0]:
                    data = data.replace(b"old file mode ", b"old mode ",
                                        1).replace(b"new file mode ",
                                                   b"new mode ", 1)
                patches.write(
                    data.split(b'\n', 1)[1] if row.status == 'R' else data)
    if not (flags.name_only or flags.name_status or flags.raw):
        table = stat_table(stats)
        lines = numbers + (table if flags.stat else
                           table[-1:] if flags.shortstat else []) + summaries
    output = ''.join(line + '\n' for line in lines).encode()
    return output + (b'\n' if output and patches.getvalue() else
                     b'') + patches.getvalue()


def entries(repo: BaseRepo, tree: bytes | None,
            recursive: bool) -> dict[bytes, tuple[int, bytes]]:
    if recursive or tree is None:
        return tree_entries(repo.object_store, tree)
    obj = repo.object_store[ObjectID(tree)]
    assert isinstance(obj, Tree)
    return {entry.path: (entry.mode, entry.sha) for entry in obj.iteritems()}


def tree_output(repo: BaseRepo,
                before: bytes | None,
                after: bytes,
                flags: DiffFlags,
                recursive: bool = True) -> bytes:
    return render_changes(
        repo,
        compare(repo, entries(repo, before, recursive),
                entries(repo, after, recursive), flags.renames), flags)


def commit_output(repo: BaseRepo,
                  commit: Commit,
                  flags: DiffFlags,
                  recursive: bool = True,
                  root: bool = True) -> list[bytes]:
    # Parent selection precedes rendering, so names, stats and patches agree.
    parents = [repo.object_store[p] for p in commit.parents]
    assert all(isinstance(p, Commit) for p in parents)
    trees = [p.tree for p in parents if isinstance(p, Commit)]
    if not trees:
        return [tree_output(repo, None, commit.tree, flags, recursive)
                ] if root else []
    if len(trees) == 1 or flags.merge == 'first-parent':
        return [tree_output(repo, trees[0], commit.tree, flags, recursive)]
    if flags.merge == 'off':
        return []
    if flags.merge == 'separate':
        return [
            tree_output(repo, tree, commit.tree, flags, recursive)
            for tree in trees
        ]
    after = entries(repo, commit.tree, recursive)
    comparisons = [
        compare(repo, entries(repo, tree, recursive), after, flags.renames)
        for tree in trees
    ]
    common = set.intersection(*({row.path
                                 for row in rows} for rows in comparisons))
    maps = [{row.path: row for row in rows} for rows in comparisons]
    if flags.no_patch:
        return []
    if flags.name_only or flags.name_status or flags.raw:
        lines = []
        for path in sorted(common):
            status = ''.join(m[path].status for m in maps)
            name = path.decode()
            if flags.name_only:
                lines.append(name)
            elif flags.name_status:
                lines.append(f'{status}\t{name}')
            else:
                old = [m[path].old or (0, b'0' * 40) for m in maps]
                new = maps[0][path].new or (0, b'0' * 40)
                lines.append(':' * len(maps) + ' '.join(f'{e[0]:06o}'
                                                        for e in [*old, new]) +
                             ' ' + ' '.join(e[1].decode()
                                            for e in [*old, new]) +
                             f' {status}\t{name}')
        return [''.join(line + '\n' for line in lines).encode()]
    # Combined stats include clean merges in the first-parent delta.
    stat = render_changes(repo, comparisons[0], replace(
        flags, patch=False)) if any((flags.stat, flags.numstat,
                                     flags.shortstat, flags.summary)) else b''
    patch = combined_patch(repo, maps, common, flags.merge
                           == 'dense-combined') if flags.patch else b''
    return [stat + (b'\n' if stat and patch else b'') + patch]


def combined_patch(repo: BaseRepo, maps: list[dict[bytes, Change]],
                   paths: set[bytes], dense: bool) -> bytes:
    out = []
    for path in sorted(paths):
        changes = [m[path] for m in maps]
        new = changes[0].new
        old = [row.old for row in changes]
        new_data = blob_data(repo, new)
        old_data = [blob_data(repo, entry) for entry in old]
        body = combined_lines([
            data.decode('utf-8', errors='replace').splitlines(keepends=True)
            for data in old_data
        ],
                              new_data.decode(
                                  'utf-8',
                                  errors='replace').splitlines(keepends=True),
                              dense)
        name = path.decode()
        out.append(f'diff --{"cc" if dense else "combined"} {name}\n')
        out.append('index ' + ','.join(
            (entry[1].decode() if entry else '0' * 40)[:7] for entry in old) +
                   '..' + (new[1].decode() if new else '0' * 40)[:7] + '\n')
        if any(entry is None or new is None or entry[0] != new[0]
               for entry in old):
            out.append('mode ' + ','.join(f'{entry[0] if entry else 0:06o}'
                                          for entry in old) + '..' +
                       f'{new[0] if new else 0:06o}\n')
        if any(b'\0' in data[:8000] for data in [*old_data, new_data]):
            out.append('Binary files differ\n')
        elif body:
            out.extend([f'--- a/{name}\n', f'+++ b/{name}\n', *body])
    return ''.join(out).encode()


def blob_data(repo: BaseRepo, entry: tuple[int, bytes] | None) -> bytes:
    if entry is None:
        return b''
    if entry[0] == 0o160000:
        return b'Subproject commit ' + entry[1] + b'\n'
    obj = repo.object_store[ObjectID(entry[1])]
    assert isinstance(obj, Blob)
    return obj.data


async def renames_enabled(dispatch: DispatchFn,
                          location: RepoLocation) -> bool:
    data = await read_optional(dispatch, f"{location.commondir}/config")
    if data is None:
        return True
    cfg = ConfigFile.from_file(BytesIO(data))
    try:
        value = cfg.get((b"diff", ), b"renames")
    except KeyError:
        return True
    return value.lower() not in (b"false", b"no", b"off", b"0", b"")


def join_output(commit: Commit,
                header: bytes,
                bodies: list[bytes],
                kind: str,
                width: int,
                empty_summary: bool = False) -> bytes:
    if not bodies:
        return header
    blocks = []
    for index, body in enumerate(bodies):
        head = header
        if len(bodies) > 1 and kind not in ("format", "tformat"):
            parent = commit.parents[index].decode()
            full = commit.id.decode()
            if kind == "oneline":
                full, parent = full[:width], parent[:width]
            head = head.replace(full.encode(),
                                f"{full} (from {parent})".encode(), 1)
        gap = b"\n" if head and body and kind != "oneline" else b""
        if not body and head and empty_summary:
            gap = b"\n"
        blocks.append(head + gap + body)
    separator = b"\n" if kind not in ("format", "tformat", "oneline") else b""
    return separator.join(blocks)
