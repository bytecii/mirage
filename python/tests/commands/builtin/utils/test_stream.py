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

from mirage.commands.builtin.utils.stream import is_stdin, operand_label
from mirage.types import PathSpec


def _operand(raw: str, virtual: str) -> PathSpec:
    return PathSpec(vfs_path=virtual.strip("/"),
                    virtual=virtual,
                    directory="/",
                    resolved=True,
                    raw_path=raw)


def test_operand_label_names_only_a_dash_stdin():
    # GNU grep, head and tail call only `-` standard input: /dev/stdin
    # reads the same bytes and is named as the path it is.
    dash = _operand("-", "/-")
    dev = _operand("/dev/stdin", "/dev/stdin")
    assert (is_stdin(dash), is_stdin(dev)) == (True, True)
    assert operand_label(dash, "(standard input)") == "(standard input)"
    assert operand_label(dev, "(standard input)") == "/dev/stdin"
    assert operand_label(_operand("a.txt", "/data/a.txt"), "-") == "a.txt"
