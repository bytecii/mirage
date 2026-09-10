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

from datetime import datetime


def gnu_strftime(dt: datetime, fmt: str) -> str:
    """Render ``fmt`` the way GNU ``date`` and ``ls --time-style=+FMT`` do.

    Two directives GNU implements itself are expanded ahead of the C
    library's strftime, which would print them as mangled literals:
    ``%q`` (quarter) and ``%N`` (nanoseconds, from the microseconds a
    timestamp carries). ``%%`` pairs are stepped over, keeping ``%%q``
    literal.

    Args:
        dt (datetime): the moment being rendered.
        fmt (str): the format as typed, without the leading ``+``.
    """
    out: list[str] = []
    i = 0
    while i < len(fmt):
        if fmt[i] == "%" and i + 1 < len(fmt):
            nxt = fmt[i + 1]
            if nxt == "q":
                out.append(str((dt.month - 1) // 3 + 1))
            elif nxt == "N":
                out.append(f"{dt.microsecond * 1000:09d}")
            else:
                out.append(fmt[i:i + 2])
            i += 2
            continue
        out.append(fmt[i])
        i += 1
    return dt.strftime("".join(out))
