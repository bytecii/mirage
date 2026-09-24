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

from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.diff_output import (DiffFlags,
                                                         parse_diff_flags,
                                                         renames_enabled,
                                                         tree_output)
from mirage.commands.cli.builtin.git.errors import (GitError,
                                                    InvalidOptionError,
                                                    NoMergeBaseError,
                                                    NoWorkspaceError)
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.revparse import (merge_bases,
                                                      range_commits,
                                                      resolve_commit)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (  # yapf: disable
    check_operands, escaped, fatal)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

# Deliberate divergence, verified against git 2.47.3 on a real
# repository. The patch is correct and applies cleanly, and file
# headers, mode lines, blob abbreviations and hunk function context
# match git exactly, but a hunk can still sit a line off where git's
# does (`@@ -3,6 +3,10 @@` against `@@ -4,6 +4,10 @@`): git slides a
# hunk to the equivalent boundary xdiff prefers (xdl_change_compact),
# so a blank line can be attributed to the additions on one side and
# the context on the other. Closing this means reimplementing that
# pass; until then do not claim byte parity for diff bodies. `log`,
# `log --oneline`, `show`'s header and `branch` ARE byte-identical.


def _render(repo: BaseRepo, texts: tuple[str, ...],
            flags: DiffFlags) -> tuple[bytes, bytes]:
    """Resolve both sides and render the patch, synchronously.

    One revision is compared with HEAD and two with each other.
    ``A..B`` is the two-revision form written as one operand, and
    ``A...B`` compares B with the merge base of the two, which is what
    a branch changed since it forked; with several bases git warns and
    takes the first (pinned against git 2.50).

    Runs on a worker thread, because resolving and reading blobs both
    fetch through the dispatcher.

    Args:
        repo (BaseRepo): repository to read.
        texts (tuple[str, ...]): the revision operands, at least one.
        flags (DiffFlags): the parsed diff flags.

    Returns:
        tuple[bytes, bytes]: the rendered diff and any warning.
    """
    warning = b""
    ends = range_commits(repo, texts[0]) if len(texts) == 1 else None
    if ends is None:
        old = resolve_commit(repo, texts[0])
        new = resolve_commit(repo, texts[1] if len(texts) >= 2 else HEAD)
    else:
        old, new, symmetric = ends
        if symmetric:
            bases = merge_bases(repo, old, new)
            if not bases:
                raise NoMergeBaseError(texts[0])
            old = bases[0]
            if len(bases) > 1:
                warning = (f"warning: {texts[0]}: multiple merge bases, "
                           f"using {old.id.decode()}\n").encode()
    return tree_output(repo, old.tree, new.tree, flags), warning


async def diff(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Diff two commits.

    One revision diffs it against HEAD's tree, two diff against each
    other. The working tree is not a party to this yet: comparing
    against it needs the index and the worktree scan, which is where
    unstaged and staged diffs live.

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
    if not texts:
        return None, IOResult()
    try:
        if dispatch is None:
            raise NoWorkspaceError()
        check_operands(texts, InvalidOptionError, escaped(inv.argv))
        repo, _location = await opened(fl, doors)
        body, warning = await asyncio.to_thread(
            _render, repo, tuple(texts),
            parse_diff_flags(fl,
                             default_renames=await
                             renames_enabled(dispatch, _location),
                             quote_path_fully=await
                             config_bool(dispatch, _location, b"core",
                                         b"quotepath", True)))
    except GitError as exc:
        return fatal(exc)
    result = IOResult(stderr=warning) if warning else IOResult()
    if not body:
        return None, result
    return yield_bytes(body), result
