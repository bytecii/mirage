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

import argparse
import asyncio
import functools
import logging
import os
import posixpath
import shlex
import tempfile
from collections.abc import AsyncIterator, Iterator

import asyncssh

# The interface the fake listens on. Loopback is right on a developer's
# machine and wrong inside a container: a server on the container's own
# 127.0.0.1 is invisible to the published port, so a client on the host has
# its connection accepted and then closed with no response -- while a
# healthcheck running inside the container sees a healthy server. Set
# MIRAGE_BIND_HOST=0.0.0.0 wherever the client is outside the container.
#
# The advertised URLs below stay on 127.0.0.1 on purpose: 0.0.0.0 is an
# interface to listen on, not an address anything can connect to.
logger = logging.getLogger(__name__)

BIND_HOST = os.environ.get("MIRAGE_BIND_HOST", "127.0.0.1")

# A directory the server's own access check refuses to list, the way
# OpenSSH answers a non-root user opening a root-owned 0700 directory:
# stat and writes by path still work, the listing is
# SSH_FX_PERMISSION_DENIED. mirage's chmod keeps owner access on purpose,
# so the battery cannot make one through the shell.
UNLISTABLE = b"unlistable"

# The one command the server answers: the remote grep an ssh mount's
# search sends, `SEARCH [-i] -e TEXT -- SCOPE...`. A server that asks for no
# password runs nothing, so it answers this one itself, reading only inside
# the served root.
SEARCH = [
    "env",
    "LC_ALL=C",
    "grep",
    "--dereference-recursive",
    "--devices=skip",
    "-lF",
    "--null",
]


class NoAuthServer(asyncssh.SSHServer):
    def begin_auth(self, username: str) -> bool:
        return False


class ChrootSFTPServer(asyncssh.SFTPServer):
    def __init__(self, root: str, chan: asyncssh.SSHServerChannel) -> None:
        super().__init__(chan, chroot=root)

    async def scandir(self, path: bytes) -> AsyncIterator[asyncssh.SFTPName]:
        if posixpath.basename(path.rstrip(b"/")) == UNLISTABLE:
            raise asyncssh.SFTPPermissionDenied("Permission denied")
        async for name in super().scandir(path):
            yield name


def _inside(root: str, path: str) -> bool:
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def _files(
    root: str, directory: str, ancestors: frozenset[str]
) -> Iterator[str | None]:
    """The regular files below ``directory`` inside ``root``, links
    followed, under every name the tree gives them; None where a link
    leads back into a directory being walked, which GNU grep reports as a
    recursive directory loop.

    Args:
        root (str): Local directory served as the SFTP root.
        directory (str): The directory walked.
        ancestors (frozenset[str]): The real paths of the directories
            above it.
    """
    real = os.path.realpath(directory)
    if real in ancestors:
        yield None
        return
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not _inside(root, path):
            continue
        if os.path.isdir(path):
            yield from _files(root, path, ancestors | {real})
        elif os.path.isfile(path):
            yield path


def search_names(
    root: str, text: bytes, fold: bool, scopes: list[str]
) -> tuple[int, bytes, bytes]:
    """What the search's grep answers over ``scopes`` under the chroot the
    SFTP server applies: the regular files holding ``text`` (ASCII case
    folded under ``fold``), links followed, NUL-ended, with grep's exit
    status. Nothing outside ``root`` is read, through a link or not, and
    a loop or an unreadable file exits 2, as grep does.

    Args:
        root (str): Local directory served as the SFTP root.
        text (bytes): The text searched for.
        fold (bool): Whether -i was given.
        scopes (list[str]): The directories, as the client named them.
    """
    root = os.path.realpath(root)
    needle = text.lower() if fold else text
    names: list[str] = []
    status = 1
    for scope in scopes:
        base = os.path.join(root, scope.lstrip("/"))
        if not _inside(root, base) or not os.path.isdir(base):
            return (
                2,
                b"",
                f"grep: {scope}: No such file or directory\n".encode(),
            )
        for path in _files(root, base, frozenset()):
            if path is None:
                status = 2
                continue
            try:
                with open(path, "rb") as handle:
                    data = handle.read()
            except OSError as exc:
                logger.debug(
                    "ssh fake search could not read %s: %s", path, exc
                )
                status = 2
                continue
            if needle in (data.lower() if fold else data):
                names.append(scope.rstrip("/") + path[len(base) :])
    if names and status != 2:
        status = 0
    return status, b"".join(n.encode() + b"\0" for n in names), b""


async def run_search(root: str, process: asyncssh.SSHServerProcess) -> None:
    """Answer the ssh search's grep, and refuse any other command.

    Args:
        root (str): Local directory served as the SFTP root.
        process (asyncssh.SSHServerProcess): The exec request.
    """
    argv = shlex.split(process.command or "")
    fold = argv[len(SEARCH) : len(SEARCH) + 1] == ["-i"]
    rest = argv[len(SEARCH) + fold :]
    if (
        argv[: len(SEARCH)] != SEARCH
        or len(rest) < 4
        or rest[::2][:2] != ["-e", "--"]
    ):
        process.stderr.write(b"only the ssh search runs here\n")
        process.exit(127)
        return
    status, out, err = await asyncio.to_thread(
        search_names, root, rest[1].encode(), fold, rest[3:]
    )
    process.stdout.write(out)
    process.stderr.write(err)
    process.exit(status)


async def start_server(root: str, port: int = 0) -> asyncssh.SSHAcceptor:
    """Start a no-auth SFTP server chrooted to root, which runs no command
    but the ssh search's grep.

    Args:
        root (str): Local directory served as the SFTP root.
        port (int): Port to listen on; 0 picks a free port.
    """
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    return await asyncssh.listen(
        BIND_HOST,
        port,
        server_host_keys=[host_key],
        server_factory=NoAuthServer,
        sftp_factory=functools.partial(ChrootSFTPServer, root),
        process_factory=functools.partial(run_search, root),
        encoding=None,
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--root", default=None)
    args = parser.parse_args()
    root = args.root or tempfile.mkdtemp(prefix="mirage-integ-ssh-")
    server = await start_server(root, args.port)
    print(
        f"SSH_HOST=127.0.0.1 SSH_PORT={server.get_port()} ROOT={root}",
        flush=True,
    )
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
