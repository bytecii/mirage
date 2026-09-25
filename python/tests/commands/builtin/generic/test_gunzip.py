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

import pytest

from mirage.commands.builtin.generic.gunzip import gunzip_writes
from mirage.commands.spec import SPECS
from mirage.workspace.executor.command.flags import parse_flags


@pytest.mark.parametrize("argv,writes", [
    ([], False),
    (["-c", "f.txt.gz"], False),
    (["-t", "f.txt.gz"], False),
    (["f.txt.gz"], True),
    (["-k", "f.txt.gz"], True),
])
def test_gunzip_writes_only_the_files_it_replaces(argv: list[str],
                                                  writes: bool):
    parsed = parse_flags(argv, SPECS["gunzip"], "gunzip", "/data")
    assert gunzip_writes(parsed.flag_kwargs, parsed.paths) is writes
