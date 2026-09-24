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

from collections.abc import Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexConfig
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.ops.generic import make_generic_ops
from mirage.ops.registry import RegisteredOp
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.bound import BoundVFS


class GenericVFS(BoundVFS):
    """A backend generated from capabilities or a CommandIO table.

    The one-file path for custom backends: supply an accessor and the
    three core functions on a ``VFSAdapter`` (readdir/read_bytes/stat),
    and the generic commands plus glob resolution are wired automatically.
    Optional fields unlock more surface (``write`` enables byte mutations,
    ``find`` and ``du`` become native fast paths), and the escape hatches
    mirror what builtin backends use: ``overrides`` suppresses generic
    commands the backend replaces, ``commands`` appends bespoke
    ``@command`` verbs, and ``ops`` registers ``@op`` handlers for FUSE
    and os-interception mounts.

    Snapshots and versions see one of two things, and the subclass
    picks which by what it owns. Content the VFS holds itself (an
    in-memory store) is mirage-owned state: override ``get_state`` and
    ``load_state`` to carry it, register the class under its name, and
    a snapshot or a version rebuilds the mount with that content and
    no override. Content that lives in a remote backend is only
    observed: keep the default state (``needs_override``), set
    ``supports_snapshot`` and fill ``FileStat.fingerprint``, and a
    snapshot pins what it read while ``Workspace.load`` asks for the
    live VFS back.

    Args:
        name (str): VFS name commands register under; also the
            registry key when the class is exposed via
            ``register_vfs`` or a ``mirage.vfs`` entry point.
        accessor (Accessor): backend handle passed to every core fn.
        io (CommandIO | VFSAdapter): resource capabilities or a prebuilt table.
        prompt (str): LLM-facing description of the mounted layout.
        write_prompt (str): appended when mounted writable.
        overrides (set[str] | None): generic command names the backend
            replaces (pass the replacements via ``commands``).
        commands (list[Callable] | None): extra ``@command``-decorated
            functions (bespoke verbs or override replacements).
        ops (list[Callable] | None): ``@op``-decorated functions or
            ``RegisteredOp`` instances for VFS/FUSE dispatch, layered
            over (and shadowing same-named entries of) the auto-derived
            set.
        auto_ops (bool): derive the VFS/FUSE op set from the table via
            ``make_generic_ops`` (read/readdir/stat plus whatever
            mutations the table carries); disable to register only
            explicit ``ops``.
        provision_overrides (dict[str, Callable] | None): per-command
            cost estimators replacing the catalog default.
        caches_reads (bool): serve repeat reads from the file cache;
            enable only for stable, read-mostly content.
        sizes_always_known (bool): whether ``io.stat`` sizes every
            regular file without fetching it. A backend that renders its
            content on read leaves this False and rides the unknown-size
            machinery; a byte store sets it, which is also what makes the
            mount legal on FSKit.
        supports_snapshot (bool): whether ``io.stat`` fills
            ``FileStat.fingerprint`` with a stable per-path version
            marker. Setting it without that is not drift detection, it is
            a snapshot that claims to have one.
        read_revalidatable (bool): whether ``io.stat`` and the read
            record stamp the *same kind* of content token, so a
            ``read: fresh`` mount can compare them. Setting it without
            that makes every read verdict stale and refetch forever; a
            mount declaring ``fresh`` on a backend that leaves it False
            is refused at mount time instead.
        index (IndexConfig | None): cache-index configuration.
    """

    def __init__(
        self,
        *,
        name: str,
        accessor: Accessor,
        io: CommandIO | VFSAdapter,
        prompt: str = "",
        write_prompt: str = "",
        overrides: set[str] | None = None,
        commands: list[Callable[..., Any]] | None = None,
        ops: list[Callable[..., Any]] | None = None,
        provision_overrides: dict[str, Callable[..., Any]] | None = None,
        auto_ops: bool = True,
        caches_reads: bool = False,
        sizes_always_known: bool = False,
        supports_snapshot: bool = False,
        read_revalidatable: bool = False,
        index: IndexConfig | None = None,
    ) -> None:
        super().__init__(io=io, index=index)
        if not name:
            raise ValueError("GenericVFS requires a non-empty name")
        io = self.io
        self.name = name
        self.accessor = accessor
        self.PROMPT = prompt
        self.WRITE_PROMPT = write_prompt
        self.caches_reads = caches_reads
        self.SIZES_ALWAYS_KNOWN = sizes_always_known
        self.SUPPORTS_SNAPSHOT = supports_snapshot
        self.READ_REVALIDATABLE = read_revalidatable
        for fn in make_generic_commands(
                name,
                io,
                overrides=overrides,
                provision_overrides=provision_overrides):
            self.register(fn)
        for fn in commands or []:
            self.register(fn)
        user_ops: list[RegisteredOp] = []
        for fn in ops or []:
            if isinstance(fn, RegisteredOp):
                user_ops.append(fn)
            else:
                user_ops.extend(getattr(fn, "_registered_ops"))
        if auto_ops:
            shadowed = {ro.name for ro in user_ops if ro.filetype is None}
            for ro in make_generic_ops(name, io, overrides=shadowed):
                self.register_op(ro)
        for ro in user_ops:
            self.register_op(ro)

    def get_state(self) -> dict[str, Any]:
        # The base cannot know a subclass's constructor, so by default a
        # GenericVFS cannot be rebuilt from its state and says so:
        # both loaders then require the mount to be handed back live
        # (``mounts=``; ``Workspace.copy`` does this itself). A
        # subclass whose content is its own, the way RAMVFS's is,
        # overrides this and ``load_state`` to carry that content and
        # drops the flag; registered under its name it rebuilds from a
        # snapshot or a version with no override, and its content is
        # what gets versioned. A subclass over a remote backend keeps
        # the flag and versions through ``supports_snapshot``
        # fingerprints instead: that content is the backend's, and a
        # snapshot only pins what it observed.
        return {"type": self.name, "needs_override": True}
