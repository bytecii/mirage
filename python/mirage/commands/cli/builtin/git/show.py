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

import asyncio
from dataclasses import dataclass
from io import BytesIO

from dulwich.objects import Commit, Tree
from dulwich.patch import write_tree_diff
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import GitError, NoWorkspaceError
from mirage.commands.cli.builtin.git.format import (MEDIUM, Decorations,
                                                    LogFormat,
                                                    needs_decorations, oneline,
                                                    parse_pretty, preset_block,
                                                    render_template)
from mirage.commands.cli.builtin.git.history import decorations, pretty_value
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.summary import (diffstat, stat_table,
                                                     tree_entries)
from mirage.commands.cli.builtin.git.util import (  # yapf: disable
    check_operands, escaped, fatal, revision_arg)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text

MERGE_PARENTS = 1

# A merge prints no ordinary diff. git renders one against every parent
# at once (`--cc`, the combined format with two prefix columns and
# `@@@` ranges), which comes out empty whenever the merge result matches
# a parent exactly, so the common merge shows only its header. Combined
# diffs are not implemented, so a merge that resolved a conflict shows
# its header and nothing else rather than a patch git would never print.


@dataclass(frozen=True, slots=True)
class ShowFlags:
    """The parsed shape of a ``git show`` invocation.

    ``--no-ext-diff`` is accepted but carries no field: there are no
    external diff drivers here, so it changes nothing by construction.

    Args:
        stat (bool): ``--stat``, the diffstat table instead of a patch.
        no_patch (bool): ``-s``/``--no-patch``, no diff section at all.
            Wins over ``--stat`` and ``--name-only`` in either order,
            which is what git 2.50 does.
        name_only (bool): ``--name-only``, changed paths instead of a
            patch. Wins over ``--stat``, pinned against git 2.50.
        pretty (LogFormat): how the header renders.
    """
    stat: bool
    no_patch: bool
    name_only: bool
    pretty: LogFormat
    name_status: bool = False
    summary: bool = False
    date: str = "default"


def parse_show_flags(fl: FlagView) -> ShowFlags:
    """Read the raw show flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    spelled = pretty_value(fl)
    return ShowFlags(
        name_status=fl.as_bool("name_status"),
        summary=fl.as_bool("summary"),
        date=fl.as_str("date") or "default",
        stat=fl.as_bool("stat"),
        no_patch=fl.as_bool("no_patch"),
        name_only=fl.as_bool("name_only"),
        pretty=parse_pretty(spelled) if spelled is not None else MEDIUM,
    )


def _header(commit: Commit, flags: ShowFlags, width: int,
            decor: Decorations | None) -> bytes:
    """The commit header in the requested format.

    ``format:`` is a separator, so a single commit prints with no
    trailing newline at all; ``tformat:`` terminates the entry even
    when it renders empty, except that an empty template prints
    nothing, matching ``log --format=``. Pinned against git 2.37 and
    2.54.

    Args:
        commit (Commit): the commit being shown.
        flags (ShowFlags): the parsed invocation.
        width (int): abbreviated id width for this repository.
        decor (Decorations | None): ref labels when the format asked.
    """
    fmt = flags.pretty
    if fmt.kind == "oneline":
        return f"{oneline(commit, width)}\n".encode()
    if fmt.kind in ("format", "tformat"):
        rendered = render_template(fmt.template or "", commit, width, decor,
                                   flags.date)
        if fmt.kind == "tformat":
            return encode_text(f"{rendered}\n") if fmt.template else b""
        return encode_text(rendered)
    return ("\n".join(preset_block(commit, fmt.kind, width, flags.date)) +
            "\n").encode()


def _diff_section(repo: BaseRepo, commit: Commit, flags: ShowFlags) -> bytes:
    """The section under the header: patch, stat, names, or nothing.

    Args:
        repo (BaseRepo): repository to read.
        commit (Commit): the commit being shown.
        flags (ShowFlags): the parsed invocation.
    """
    if flags.no_patch:
        return b""
    store = repo.object_store
    parent_tree = None
    if commit.parents:
        parent = store[commit.parents[0]]
        assert isinstance(parent, Commit)
        parent_tree = parent.tree
    if flags.name_only or flags.stat or flags.name_status or flags.summary:
        before = tree_entries(store, parent_tree)
        after = tree_entries(store, commit.tree)
        if flags.name_only or flags.name_status or flags.summary:
            changed = sorted(path for path in set(before) | set(after)
                             if before.get(path) != after.get(path))
            lines = []
            for path in changed:
                name = path.decode("utf-8", errors="replace")
                old, new = before.get(path), after.get(path)
                if flags.name_only:
                    lines.append(name)
                elif flags.name_status:
                    if old is None:
                        status = "A"
                    elif new is None:
                        status = "D"
                    elif old[0] & 0o170000 != new[0] & 0o170000:
                        status = "T"
                    else:
                        status = "M"
                    lines.append(f"{status}\t{name}")
                elif old is None:
                    assert new is not None
                    lines.append(f" create mode {new[0]:06o} {name}")
                elif new is None:
                    lines.append(f" delete mode {old[0]:06o} {name}")
                elif old[0] != new[0]:
                    lines.append(
                        f" mode change {old[0]:06o} => {new[0]:06o} {name}")
            return "".join(f"{line}\n" for line in lines).encode()
        lines = stat_table(diffstat(store, before, after))
        return "".join(f"{line}\n" for line in lines).encode()
    patch = BytesIO()
    write_tree_diff(patch, store, parent_tree, commit.tree)
    return patch.getvalue()


def _render(repo: BaseRepo, revision: str, flags: ShowFlags,
            want_decor: bool) -> bytes:
    """Resolve a revision and render its entry and diff, synchronously.

    Runs on a worker thread: resolving, walking the tree and reading
    blobs all fetch through the dispatcher, so this must not sit on the
    loop that answers those fetches.

    Args:
        repo (BaseRepo): repository to read.
        revision (str): the revision to show.
        flags (ShowFlags): the parsed invocation.
        want_decor (bool): whether the format renders %d/%D.
    """
    commit = resolve_commit(repo, revision)
    decor = decorations(repo) if want_decor else None
    header = _header(commit, flags, abbrev_for(repo), decor)
    if len(commit.parents) > MERGE_PARENTS:
        return header
    body = _diff_section(repo, commit, flags)
    if not body:
        return header + (b"\n" if header and flags.summary
                         and not flags.no_patch else b"")
    if not header:
        return body
    return header + b"\n" + body


async def show(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Show one commit: its log entry, then its diff against its parent.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
            git declares no config_model; the planes it reads
            (data through ``dispatch``, names through ``ns``) ride
            ``inv.doors``.
    """
    doors = inv.doors or CLIDoors()
    dispatch = doors.dispatch
    texts = inv.texts
    flags = inv.flags
    fl = FlagView(flags)
    try:
        if dispatch is None:
            raise NoWorkspaceError()
        check_operands(texts, marked=escaped(inv.argv))
        parsed = parse_show_flags(fl)
        repo, _location = await opened(fl, doors)
        rendered = await asyncio.to_thread(_render, repo, revision_arg(texts),
                                           parsed,
                                           needs_decorations(parsed.pretty))
    except GitError as exc:
        return fatal(exc)
    return yield_bytes(rendered), IOResult()


def _diff_tree(repo: BaseRepo, revision: str, flags: ShowFlags,
               no_commit_id: bool, recursive: bool) -> bytes:
    commit = resolve_commit(repo, revision)
    if len(commit.parents) != 1:
        return b""
    parent = repo.object_store[commit.parents[0]]
    assert isinstance(parent, Commit)
    if recursive:
        before = tree_entries(repo.object_store, parent.tree)
        after = tree_entries(repo.object_store, commit.tree)
    else:
        old_tree = repo.object_store[parent.tree]
        new_tree = repo.object_store[commit.tree]
        assert isinstance(old_tree, Tree) and isinstance(new_tree, Tree)
        before = {
            entry.path: (entry.mode, entry.sha)
            for entry in old_tree.iteritems()
        }
        after = {
            entry.path: (entry.mode, entry.sha)
            for entry in new_tree.iteritems()
        }
    lines = []
    if not flags.no_patch:
        for path in sorted(set(before) | set(after)):
            old, new = before.get(path), after.get(path)
            if old == new:
                continue
            name = path.decode("utf-8", errors="replace")
            status = ("A"
                      if old is None else "D" if new is None else "T" if old[0]
                      & 0o170000 != new[0] & 0o170000 else "M")
            if flags.name_only:
                lines.append(name)
            elif flags.name_status:
                lines.append(f"{status}\t{name}")
            else:
                old_mode, old_sha = old or (0, b"0" * 40)
                new_mode, new_sha = new or (0, b"0" * 40)
                lines.append(f":{old_mode:06o} {new_mode:06o} "
                             f"{old_sha.decode()} {new_sha.decode()} "
                             f"{status}\t{name}")
    body = "".join(f"{line}\n" for line in lines).encode()
    if flags.stat or flags.summary:
        body = _diff_section(repo, commit, flags)
    return (b"" if no_commit_id else commit.id + b"\n") + body


async def diff_tree(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    try:
        repo, _ = await opened(fl, inv.doors or CLIDoors())
        out = await asyncio.to_thread(_diff_tree, repo,
                                      inv.texts[0] if inv.texts else "HEAD",
                                      parse_show_flags(fl),
                                      fl.as_bool("no_commit_id"),
                                      fl.as_bool("r"))
        return out, IOResult()
    except GitError as exc:
        return fatal(exc)
