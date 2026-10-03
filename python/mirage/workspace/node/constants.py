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

from mirage.shell.syntax.node_kind import NodeKind
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import VarAttr

STREAMING_KINDS = frozenset({
    NodeKind.PROGRAM,
    NodeKind.COMPOUND,
    NodeKind.LIST,
    NodeKind.SUBSHELL,
    NodeKind.IF,
    NodeKind.FOR,
    NodeKind.CFOR,
    NodeKind.SELECT,
    NodeKind.WHILE,
    NodeKind.UNTIL,
    NodeKind.CASE,
    NodeKind.NEGATED,
})

_SUBSCRIPT_LITERAL_TYPES = frozenset({NT.WORD, NT.NUMBER, NT.ERROR})

# Every letter GNU's `declare` accepts, so a typo refuses with the usage
# line instead of being silently dropped. `-a`/`-A` are kinds, not
# attributes, and are handled by the array branch; `-p`/`-f`/`-F`/`-g`
# /`-I` are modes the handlers read. `-n` stores the reference and every
# reader and writer resolves through it (`deref` in `session/state`).
_DECLARE_LETTERS = frozenset("aAfFgiIlnprtux")

_DECLARE_USAGE = (
    "declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] "
    "or declare -p [-aAfFilnrtux] [name ...]")

# The stored attributes a `-letter` / `+letter` toggles.
_ATTR_LETTERS = {
    "i": VarAttr.INTEGER,
    "l": VarAttr.LOWER,
    "u": VarAttr.UPPER,
    "n": VarAttr.NAMEREF,
    "t": VarAttr.TRACE,
    "x": VarAttr.EXPORT,
    "r": VarAttr.READONLY,
}
