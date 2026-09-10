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

GNU_FLAG_CHARS = "-_0^#"
GNU_PAD_FLAGS = "-_0"


def pad_quarter(quarter: str, flags: str, width: int | None) -> str:
    """Pad ``%q``'s digit the way GNU date pads a number.

    ``-`` drops the padding, ``_`` pads with spaces, ``0`` with zeros,
    and the last of the three typed wins (``%_-2q`` is ``3``, ``%-_2q``
    is ``" 3"``); a bare width zero-pads.

    Args:
        quarter (str): the quarter digit.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    pad = "0"
    for ch in flags:
        if ch in GNU_PAD_FLAGS:
            pad = ch
    if pad == "-" or width is None:
        return quarter
    return quarter.rjust(width, " " if pad == "_" else "0")


def gnu_strftime(dt: datetime, fmt: str) -> str:
    """Render ``fmt`` the way GNU ``date`` and ``ls --time-style=+FMT`` do.

    Two directives GNU implements itself are expanded ahead of the C
    library's strftime, which would print them as mangled literals:
    ``%q`` (quarter) and ``%N`` (nanoseconds, from the microseconds a
    timestamp carries). Both take GNU's flag and width prefix
    (``%3N``, ``%_3N``, ``%2q``), pinned against date 9.7: a width on
    ``N`` keeps that many leading digits and pads wider widths with
    zeros on the right (``%3N`` is milliseconds, ``%12N`` appends three
    zeros) and its flags change nothing, while a width on ``q`` pads on
    the left under the padding flags (``%_2q`` is ``" 3"``, ``%-2q`` is
    ``3``). Every other directive passes to strftime
    with its prefix intact; ``%%`` pairs are stepped over, keeping
    ``%%q`` literal.

    Args:
        dt (datetime): the moment being rendered.
        fmt (str): the format as typed, without the leading ``+``.
    """
    out: list[str] = []
    i = 0
    while i < len(fmt):
        if fmt[i] != "%":
            out.append(fmt[i])
            i += 1
            continue
        j = i + 1
        while j < len(fmt) and fmt[j] in GNU_FLAG_CHARS:
            j += 1
        k = j
        while k < len(fmt) and fmt[k].isdigit():
            k += 1
        if k >= len(fmt):
            out.append(fmt[i:])
            break
        width = int(fmt[j:k]) if k > j else None
        directive = fmt[k]
        if directive == "q":
            quarter = str((dt.month - 1) // 3 + 1)
            out.append(pad_quarter(quarter, fmt[i + 1:j], width))
        elif directive == "N":
            nanos = f"{dt.microsecond * 1000:09d}"
            out.append(nanos[:width].ljust(width, "0") if width else nanos)
        else:
            out.append(fmt[i:k + 1])
        i = k + 1
    return dt.strftime("".join(out))
