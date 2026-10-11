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
import os
import posixpath
import shlex
import tempfile
from collections.abc import AsyncIterator

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
BIND_HOST = os.environ.get("MIRAGE_BIND_HOST", "127.0.0.1")

# A directory the server's own access check refuses to list, the way
# OpenSSH answers a non-root user opening a root-owned 0700 directory:
# stat and writes by path still work, the listing is
# SSH_FX_PERMISSION_DENIED. mirage's chmod keeps owner access on purpose,
# so the battery cannot make one through the shell.
UNLISTABLE = b"unlistable"

# The one command the server runs: the remote grep an ssh mount's search
# sends. Nothing else runs on a server that asks for no password.
GREP = ["env", "LC_ALL=C", "grep"]


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


async def run_grep(root: str, process: asyncssh.SSHServerProcess) -> None:
    """Run the search's grep without a shell, under the same chroot the
    SFTP server applies: each scope is taken under ``root``, and each name
    grep prints is given back as the client named it.

    Args:
        root (str): Local directory served as the SFTP root.
        process (asyncssh.SSHServerProcess): The exec request.
    """
    argv = shlex.split(process.command or "")
    if argv[:3] != GREP or "--" not in argv:
        process.stderr.write(b"only the search's grep runs here\n")
        process.exit(127)
        return
    cut = argv.index("--") + 1
    scopes = [scope.lstrip("/") or "." for scope in argv[cut:]]
    child = await asyncio.create_subprocess_exec(
        *argv[:cut],
        *scopes,
        cwd=root,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await child.communicate()
    names = [name.removeprefix(b"./") for name in out.split(b"\0")[:-1]]
    process.stdout.write(b"".join(b"/" + name + b"\0" for name in names))
    process.stderr.write(err)
    process.exit(child.returncode or 0)


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
        process_factory=functools.partial(run_grep, root),
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
