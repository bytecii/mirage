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

import re

_ENV_HELP_HINT = "Try 'env --help' for more information.\n"

_EXPORT_USAGE = "export: usage: export [-fn] [name[=value] ...] or export -p\n"

_READONLY_USAGE = (
    "readonly: usage: readonly [-aAf] [name[=value] ...] or readonly -p\n")

_EXPORT_FLAGS = frozenset("fnp")

_READONLY_FLAGS = frozenset("aAfp")

_ANSI_C_ESCAPES = {
    "\\": "\\\\",
    "'": "\\'",
    "\a": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    "\x1b": "\\E",
}

_BARE_KEY_RE = re.compile(r"[A-Za-z0-9_%+,./:=@~-]+\Z")

# `read` options that take a value, so a scan of the raw words can step
# over the value rather than read its letters as options.
_READ_VALUE_LETTERS = frozenset("adnNtpiu")

_IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# `arr[0]` and friends: a target that parses as an assignment but is
# not a plain name, which the declaration builtins quote on its own.
_SUBSCRIPT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\[.*\]")

_TRAP_USAGE = "trap: usage: trap [-p] [action signal_spec ...]\n"
_TRAP_EXIT_NAMES = frozenset({"EXIT", "0"})
