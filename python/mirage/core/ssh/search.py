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

import logging

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.utils import join_root
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)

# The remote search: grep in the C locale, so it compares bytes as mirage
# reads them; --dereference-recursive, so it reads every file the walk can
# reach, a link's target included (GNU's spelling of -R: BSD grep's -R
# follows no link, and refuses this one); and --null, so a name ends where
# a NUL does. `env` sets the locale under any login shell.
GREP = "env LC_ALL=C grep --dereference-recursive -lF --null"


def grep_command(text: str, scopes: list[str], ignore_case: bool) -> str:
    """The remote grep that lists the files under ``scopes`` holding
    ``text``.

    Args:
        text (str): the plain text.
        scopes (list[str]): the remote directories.
        ignore_case (bool): fold ASCII case.
    """
    words = [GREP, *(["-i"] if ignore_case else []), "-e", single_quote(text)]
    return " ".join([*words, "--", *map(single_quote, scopes)])


async def files_containing(
    accessor: SSHAccessor,
    text: str,
    under: list[PathSpec],
    ignore_case: bool,
) -> list[PathSpec] | None:
    """The files under ``under`` whose bytes hold ``text``, as grep on the
    server finds them.

    The answer is exact, since every file is searched, so a whole word
    is asked as plain text: a file the word only sits inside is one more
    read. Only an exit of 0 or 1 with nothing on stderr answers: a
    server that runs no commands, a grep that refuses an option (busybox
    exits 1 for one), or a file it could not read (which the walk then
    reports) leaves every file to be read.

    Args:
        accessor (SSHAccessor): the mount's connection.
        text (str): the plain text.
        under (list[PathSpec]): the directories walked.
        ignore_case (bool): fold ASCII case, which is all the text needs.
    """
    root = accessor.config.root
    scopes = [join_root(root, p.mount_path) for p in under]
    try:
        status, out, err = await accessor.run(
            grep_command(text, scopes, ignore_case)
        )
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh search left to the scan: %s", exc)
        return None
    if status not in (0, 1) or err:
        return None
    base = root.rstrip("/")
    hits: list[PathSpec] = []
    for raw in out.split(b"\0")[:-1]:
        try:
            name = raw.decode()
        except UnicodeDecodeError:
            return None
        if not name.startswith(base + "/"):
            return None
        hits.append(mounted_path(under[0], name[len(base) :]))
    return hits
