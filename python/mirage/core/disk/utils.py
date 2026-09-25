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

import os
import stat
from pathlib import Path

from mirage.core.disk.errors import disk_error
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def resolve_inside(root: Path, path: str, spec: PathSpec | str) -> Path:
    """The host path for a mount path, refused as absent when a component
    below the root is a symlink.

    A VFS never stores a symlink, so a host link is not an entry of the
    mount: following it would let a path the root admits spelled-wise
    read or write wherever the link points on the host, and ``readdir``
    leaves it out so every walk agrees. Components past the first absent
    one are left to the op, which answers its own ENOENT or creates.
    Mirrors TypeScript's ``resolveInside``.

    It answers for the tree as it stands when called. The mount's own
    writers cannot make a host link (``ln -s`` lands in the namespace),
    but another host process that swaps a directory for a link between
    this check and the op is beyond it: closing that race needs every op
    to walk by file descriptor with ``O_NOFOLLOW`` (openat2's
    ``RESOLVE_BENEATH``), which ``node:fs`` cannot express, so neither
    twin does.

    It runs on the caller's thread, the event loop included, as the
    ``Path.resolve()`` it replaced did, and works on strings rather than
    ``Path`` objects. The ``lstat`` calls themselves are cheap: on
    MCP-Atlas's ``/data``, a nine-component path costs about 14 us this
    way, against 86 us through ``pathlib``. Handing each call to a thread
    would add about 40 us to every op.

    Args:
        root (Path): the mount root on the host.
        path (str): the mount-relative path.
        spec (PathSpec | str): the operand, the path any refusal names.
    """
    base = str(root)
    full = os.path.normpath(os.path.join(base, path.lstrip("/")))
    prefix = base if base.endswith(os.sep) else base + os.sep
    if full != base and not full.startswith(prefix):
        raise ValueError(f"path escapes root: {path}")
    at = base
    for part in full[len(base):].split(os.sep):
        if not part:
            continue
        at = os.path.join(at, part)
        try:
            info = os.lstat(at)
        except (FileNotFoundError, NotADirectoryError):
            return Path(full)
        except OSError as exc:
            virtual = spec if isinstance(spec, str) else spec.virtual
            raise disk_error(exc, virtual) from exc
        if stat.S_ISLNK(info.st_mode):
            raise enoent(spec)
    return Path(full)
