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

from dataclasses import dataclass
from typing import Callable

from mirage.commands.builtin.utils.backup import (DEFAULT_BACKUP_SUFFIX,
                                                  backup_control, sibling_path)
from mirage.commands.builtin.utils.copy import (backend_key_default,
                                                copy_targets, is_directory,
                                                path_exists)
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import (MoveStrategy, PathSpec, PrimitiveMove, ReaddirFn,
                          StatFn)
from mirage.utils.errors import FS_ERRORS, fs_strerror

from mirage.commands.builtin.generic.cp import (  # isort: skip
    TransferPolicy, copy_entries, entry_kind, make_backup, overwrite_gate,
    overwrite_type_error, split_operands, target_dir_error, update_mode, walk,
    wrap_target_dir)


@dataclass(frozen=True, slots=True)
class MvFlags:
    no_clobber: bool = False
    verbose: bool = False
    update: str | None = None
    backup: str | None = None
    suffix: str = DEFAULT_BACKUP_SUFFIX
    # Single-mount dispatch delivers the -t value as PathSpec; the
    # cross-mount relay's string view is wrapped against the first source.
    target_dir: PathSpec | str | None = None
    no_target_dir: bool = False
    exchange: bool = False
    no_copy: bool = False


def parse_mv_flags(fl: FlagView) -> MvFlags:
    """Parse the mv flag bag once into a frozen struct.

    ``-f``/``-i`` are accepted no-ops (non-interactive control plane:
    overwrite always proceeds unless ``-n``/``--update`` say otherwise),
    and ``--strip-trailing-slashes`` is a no-op because PathSpec already
    normalizes trailing slashes.

    Args:
        fl (FlagView): Flag view constructed with the mv spec.
    """
    update = update_mode("mv", fl)
    suffix = fl.as_str("S") or fl.as_str("suffix")
    backup_value = fl.raw("backup")
    if backup_value in (None, False):
        backup_value = fl.raw("b")
    control = backup_control("mv", backup_value, suffix)
    no_clobber = fl.as_bool("n") or fl.as_bool("no_clobber")
    exchange = fl.as_bool("exchange")
    if control is not None and control != "none" and (exchange or no_clobber or
                                                      update == "none-fail"):
        raise UsageError(
            "mv: cannot combine --backup with --exchange, -n, or "
            "--update=none-fail\nTry 'mv --help' for more information.", 1)
    target_dir: object = fl.raw("t")
    if target_dir is None:
        target_dir = fl.raw("target_directory")
    if not isinstance(target_dir, (PathSpec, str)):
        target_dir = None
    no_target = fl.as_bool("T") or fl.as_bool("no_target_directory")
    if target_dir is not None and no_target:
        raise UsageError(
            "mv: cannot combine --target-directory (-t) and "
            "--no-target-directory (-T)", 1)
    return MvFlags(
        no_clobber=no_clobber,
        verbose=fl.as_bool("v") or fl.as_bool("verbose"),
        update=update,
        backup=control,
        suffix=suffix if suffix is not None else DEFAULT_BACKUP_SUFFIX,
        target_dir=target_dir,
        no_target_dir=no_target,
        exchange=exchange,
        no_copy=fl.as_bool("no_copy"),
    )


async def _entry_gone(strategy: PrimitiveMove, stat: StatFn, entry: PathSpec,
                      is_dir: bool) -> bool:
    """Confirm a failed removal actually left something behind.

    On dirless object stores a directory vanishes with its last child, so
    a failed ``rmdir`` of a path that no longer exists (or that no longer
    lists any children — an existing empty directory is impossible there)
    is a completed removal, not an error. The listing check covers index
    backends whose per-entry stat can lag a just-unlinked child within a
    command.

    Args:
        strategy (PrimitiveMove): Transfer primitives for both mounts.
        stat (StatFn): Stats a path; raises when missing.
        entry (PathSpec): The path whose removal failed.
        is_dir (bool): Whether the entry is a directory.

    Returns:
        bool: True when nothing of the source remains at ``entry``.
    """
    if not await path_exists(stat, entry):
        return True
    if not is_dir:
        return False
    try:
        children = await strategy.readdir(entry)
    except FS_ERRORS:
        return True
    return not children


async def _remove_entries(
    strategy: PrimitiveMove,
    stat: StatFn,
    entries: list[tuple[PathSpec, bool]],
    errors: list[str],
) -> tuple[bool, bool]:
    """Remove copied source entries children first, GNU rm style.

    A failed removal is reported per entry (``mv: cannot remove ...``) and
    the remaining entries are still attempted; directories with a failed
    descendant are skipped silently like GNU, which never reports the
    not-empty ancestors of a file it could not remove. A failure is
    confirmed via ``_entry_gone`` first, so a source that already vanished
    (dirless object stores) is a completed removal, not an error.

    Args:
        strategy (PrimitiveMove): Transfer primitives for both mounts.
        stat (StatFn): Stats a path; raises when missing.
        entries (list[tuple[PathSpec, bool]]): ``walk`` output, parents
            first; removal runs it in reverse.
        errors (list[str]): Collected stderr lines, appended in place.

    Returns:
        tuple[bool, bool]: ``(removed_any, removed_all)`` — whether the
        source changed at all, and whether it is fully gone.
    """
    failed: list[str] = []
    removed_any = False
    for entry, is_dir in reversed(entries):
        base = entry.virtual.rstrip("/")
        if is_dir and any(f.startswith(base + "/") for f in failed):
            failed.append(base)
            continue
        try:
            await (strategy.rmdir if is_dir else strategy.unlink)(entry)
        except FS_ERRORS as exc:
            if await _entry_gone(strategy, stat, entry, is_dir):
                removed_any = True
                continue
            errors.append(f"mv: cannot remove '{entry.virtual}': "
                          f"{fs_strerror(exc)}")
            failed.append(base)
            continue
        removed_any = True
    return removed_any, not failed


async def _exchange_pair(
    strategy: MoveStrategy,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    errors: list[str],
    writes: dict[str, ByteSource],
    lines: list[str] | None,
) -> None:
    """Atomically swap two entries via three renames (``--exchange``).

    Both sides must exist. Deliberate divergence: where GNU's renameat2
    probe degrades a missing side to ``Unknown error -1``, the honest
    errno text is reported instead. A cross-mount exchange fails like
    GNU on a cross-device rename.

    Args:
        strategy (MoveStrategy): Complete native or primitive move
            capability.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): First operand of the swap.
        target (PathSpec): Second operand of the swap.
        errors (list[str]): Collected stderr lines, appended in place.
        writes (dict[str, ByteSource]): Recorded writes, updated in place.
        lines (list[str] | None): Verbose sink; None keeps the swap silent.
    """
    if isinstance(strategy, PrimitiveMove):
        errors.append(f"mv: cannot exchange '{src.virtual}' and "
                      f"'{target.virtual}': Invalid cross-device link")
        return
    if not await path_exists(stat, src) \
            or not await path_exists(stat, target):
        errors.append(f"mv: cannot exchange '{src.virtual}' and "
                      f"'{target.virtual}': No such file or directory")
        return
    holding = sibling_path(target, ".~xchg~")
    try:
        await strategy.rename(src, holding)
        await strategy.rename(target, src)
        await strategy.rename(holding, target)
    except FS_ERRORS as exc:
        errors.append(f"mv: cannot exchange '{src.virtual}' and "
                      f"'{target.virtual}': {fs_strerror(exc)}")
        return
    writes[src.mount_path] = b""
    writes[target.mount_path] = b""
    if lines is not None:
        lines.append(f"exchanged '{src.virtual}' <-> '{target.virtual}'")


async def mv(
    paths: list[PathSpec],
    *,
    stat: StatFn,
    strategy: MoveStrategy,
    flags: MvFlags,
    backend_key: Callable[[PathSpec], str] | None = None,
    readdir: ReaddirFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Move sources to a destination, fanning out into a directory.

    ``NativeMove`` uses an atomic backend rename. ``PrimitiveMove`` handles
    cross-mount moves by copying the tree (parents first, via ``walk`` plus
    ``mkdir``/``write``) and then removing the source children first.
    Failures follow GNU mv on a cross-device move: a copy failure keeps the
    whole source and skips removal, a removal failure (e.g. a source mount
    with no ``unlink``) reports ``cannot remove`` and leaves the copied
    destination in place; either way the remaining sources still move.
    ``-n``/``--update``/``--backup`` gate whole source operands (rename
    semantics), never individual entries of a tree.

    Args:
        paths (list[PathSpec]): Source operands, plus the destination
            unless ``flags.target_dir`` carries it.
        stat (Callable): Stats a path; raises when missing.
        strategy (MoveStrategy): Complete native or primitive move capability.
        flags (MvFlags): Parsed mv flags.
        backend_key (Callable | None): Maps a path to its backend storage key
            for the same-file and into-own-subtree guards; defaults to the
            normalized mount-relative path.
        readdir (ReaddirFn | None): Directory lister for backup version
            scans and the ``-T`` empty-directory probe; the primitive
            strategy's own lister is used when None.

    Returns:
        tuple[ByteSource | None, IOResult]: Verbose output and recorded
        writes, with per-source coreutils errors on stderr and exit code 1
        when any source failed.
    """
    key_of = backend_key if backend_key is not None else backend_key_default
    sources, dst = split_operands("mv", paths, flags.target_dir,
                                  flags.no_target_dir)
    if dst is None:
        dst = (flags.target_dir if isinstance(flags.target_dir, PathSpec) else
               wrap_target_dir(sources[0], str(flags.target_dir)))
        err = await target_dir_error("mv", stat, dst)
        if err is not None:
            return None, IOResult(stderr=f"{err}\n".encode(), exit_code=1)
        dst_is_dir = True
    elif flags.no_target_dir:
        dst_is_dir = False
    else:
        dst_is_dir = await is_directory(stat, dst)
    if readdir is None and isinstance(strategy, PrimitiveMove):
        readdir = strategy.readdir
    policy = TransferPolicy(cmd_name="mv",
                            no_clobber=flags.no_clobber,
                            update=flags.update,
                            backup=flags.backup,
                            suffix=flags.suffix)
    writes: dict[str, ByteSource] = {}
    lines: list[str] = []
    errors: list[str] = []
    for src, target in copy_targets(sources, dst, dst_is_dir):
        src_exists, src_is_dir = await entry_kind(stat, src)
        if not src_exists:
            errors.append(f"mv: cannot stat '{src.virtual}': "
                          "No such file or directory")
            continue
        if key_of(src) == key_of(target):
            errors.append(f"mv: '{src.virtual}' and '{target.virtual}' "
                          "are the same file")
            continue
        if flags.exchange:
            await _exchange_pair(strategy, stat, src, target, errors, writes,
                                 lines if flags.verbose else None)
            continue
        if key_of(target).startswith(key_of(src) + "/"):
            errors.append(f"mv: cannot move '{src.virtual}' to a "
                          f"subdirectory of itself, '{target.virtual}'")
            continue
        target_exists, target_is_dir = await entry_kind(stat, target)
        mismatch = overwrite_type_error("mv", src, src_is_dir, target,
                                        target_exists, target_is_dir)
        if mismatch is not None:
            errors.append(mismatch)
            continue
        if flags.no_copy and isinstance(strategy, PrimitiveMove):
            errors.append(f"mv: cannot move '{src.virtual}' to "
                          f"'{target.virtual}': Invalid cross-device link")
            continue
        if src_is_dir and target_is_dir and flags.no_target_dir \
                and readdir is not None:
            try:
                children = await readdir(target)
            except FS_ERRORS:
                children = []
            if children:
                errors.append(f"mv: cannot overwrite '{target.virtual}': "
                              "Directory not empty")
                continue
        if not await overwrite_gate(policy, stat, src, target, errors):
            continue
        backup, ok = await make_backup(policy, strategy, stat, readdir, target,
                                       writes, errors)
        if not ok:
            continue
        if isinstance(strategy, PrimitiveMove):
            entries = await walk(strategy.readdir, stat, src)
            copied_all, wrote_any = await copy_entries("mv", strategy, stat,
                                                       src, target, entries,
                                                       errors)
            if wrote_any:
                writes[target.mount_path] = b""
            if not copied_all:
                # GNU keeps the whole source tree when any copy failed;
                # the destination keeps the entries that landed.
                continue
            removed_any, removed_all = await _remove_entries(
                strategy, stat, entries, errors)
            if removed_any:
                writes[src.mount_path] = b""
            if not removed_all:
                # GNU leaves the copied destination in place and reports
                # the source entries it could not remove.
                continue
        else:
            await strategy.rename(src, target)
            writes[src.mount_path] = b""
            writes[target.mount_path] = b""
        if flags.verbose:
            line = f"renamed '{src.virtual}' -> '{target.virtual}'"
            if backup is not None:
                line += f" (backup: '{backup.virtual}')"
            lines.append(line)
    output = "\n".join(lines) + "\n" if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output.encode() if output else None, IOResult(
        writes=writes,
        stderr=stderr,
        exit_code=1 if errors else 0,
    )
