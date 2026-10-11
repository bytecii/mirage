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

import asyncssh
import pytest

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.search import files_containing, grep_command
from mirage.types import PathSpec
from mirage.vfs.ssh.config import SSHConfig

Answer = tuple[int | None, bytes, bytes] | Exception


class _Accessor(SSHAccessor):
    """An accessor whose server answers every command with ``answer``.

    Args:
        root (str): the mount's remote root.
        answer (Answer): the run's status, output and error output, or
            what it raises.
    """

    def __init__(self, root: str, answer: Answer) -> None:
        super().__init__(SSHConfig(host="example.test", root=root))
        self.answer = answer
        self.sent: list[str] = []

    async def run(self, command: str) -> tuple[int | None, bytes, bytes]:
        self.sent.append(command)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def _scope(vfs_path: str = "") -> PathSpec:
    virtual = "/s/" + vfs_path if vfs_path else "/s"
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=vfs_path, raw_path=virtual
    )


def test_grep_command_quotes_the_text_and_every_scope():
    assert grep_command("it's", ["data/a b"], True) == (
        "env LC_ALL=C grep --dereference-recursive -lF --null -i "
        "-e 'it'\\''s' -- 'data/a b'"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "root, under, scope, out, want",
    [
        ("/", "", "'/'", b"/a.txt\0/sub/c.txt\0", ["a.txt", "sub/c.txt"]),
        ("data", "sub", "'data/sub'", b"data/sub/c.txt\0", ["sub/c.txt"]),
        ("/srv/data/", "", "'/srv/data'", b"/srv/data/x\0", ["x"]),
        ("data", "", "'data'", b"", []),
    ],
)
async def test_files_containing_names_what_grep_lists(
    root, under, scope, out, want
):
    accessor = _Accessor(root, (0 if out else 1, out, b""))
    hits = await files_containing(accessor, "hello", [_scope(under)], False)
    assert hits is not None
    assert [p.vfs_path for p in hits] == want
    assert accessor.sent == [f"{grep_command('hello', [], False)} {scope}"]


# Only a clean run answers: a file grep could not read (exit 2, which the
# walk then reports), a grep refusing an option (busybox exits 1 for one),
# a signal, a name outside the root or not UTF-8, and a server that runs
# no command all leave every file to be read.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        (2, b"/data/a.txt\0", b""),
        (1, b"", b"grep: unrecognized option\n"),
        (None, b"", b""),
        (0, b"/elsewhere/a\0", b""),
        (0, b"/data/\xff\0", b""),
        asyncssh.ChannelOpenError(1, "no exec"),
    ],
)
async def test_files_containing_leaves_an_unclean_run_to_the_scan(answer):
    accessor = _Accessor("/data", answer)
    assert await files_containing(accessor, "hello", [_scope()], False) is None
