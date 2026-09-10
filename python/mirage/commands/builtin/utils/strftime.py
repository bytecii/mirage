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

GNU_FLAG_CHARS = "-_0^#+"
GNU_PAD_FLAGS = "-_0+"
# The directives GNU's `+` flag signs, with the digits each shows before
# the sign becomes necessary.
YEARISH_DIGITS = {"Y": 4, "G": 4, "C": 2}


def winning_pad(flags: str) -> str | None:
    """The padding flag GNU applies: the last of ``-``, ``_``, ``0`` and
    ``+`` typed (``%_-2q`` is ``3``, ``%-_2q`` is ``" 3"``), None when
    none was.

    Args:
        flags (str): the flag characters typed between ``%`` and the
            width.
    """
    pad = None
    for ch in flags:
        if ch in GNU_PAD_FLAGS:
            pad = ch
    return pad


def pad_quarter(quarter: str, flags: str, width: int | None) -> str:
    """Pad ``%q``'s digit the way GNU date pads a number.

    ``-`` drops the padding, ``_`` pads with spaces, ``0`` and ``+`` with
    zeros, and the last of them typed wins; a bare width zero-pads.

    Args:
        quarter (str): the quarter digit.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    pad = winning_pad(flags)
    if pad == "-" or width is None:
        return quarter
    return quarter.rjust(width, " " if pad == "_" else "0")


def plus_year(dt: datetime, directive: str, width: int | None) -> str:
    """Render ``%+Y``, ``%+G`` or ``%+C`` as GNU date does: zero-padded
    to the width, and led by ``+`` when the value outgrows the digits
    the directive normally shows or the width leaves room for a sign
    (``%+5Y`` is ``+2026``, ``%+4Y`` is ``2026``, ``%+6Y`` is ``+02026``,
    ``%+3C`` is ``+20``).

    Args:
        dt (datetime): the moment being rendered.
        directive (str): ``Y``, ``G`` or ``C``.
        width (int | None): the minimum field width, if typed.
    """
    if directive == "Y":
        value = dt.year
    elif directive == "G":
        value = dt.isocalendar()[0]
    else:
        value = dt.year // 100
    digits = YEARISH_DIGITS[directive]
    signed = value > 10**digits - 1 or (width is not None and width > digits)
    sign = "+" if signed else ""
    return sign + str(value).rjust((width or 0) - len(sign), "0")


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
    ``3``). GNU's ``+`` flag is expanded here too, since the C library
    does not know it: on ``Y``, ``G`` and ``C`` it signs the value
    (``plus_year``), on ``F`` it signs the year the width reaches
    (``%+12F`` is ``+02026-09-03``), and anywhere else it is ``0``, so
    ``%+5d`` reaches strftime as ``%05d``; a ``+`` that a later padding
    flag outranks is dropped. Every other directive passes to strftime
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
        elif "+" in fmt[i + 1:j]:
            flags = fmt[i + 1:j]
            if winning_pad(flags) == "+" and directive in YEARISH_DIGITS:
                out.append(plus_year(dt, directive, width))
            elif winning_pad(flags) == "+" and directive == "F":
                # %F is %+4Y-%m-%d, so the width reaches the year.
                year = plus_year(dt, "Y", width - 6 if width else None)
                out.append(year + dt.strftime("-%m-%d"))
            else:
                zero = "0" if winning_pad(flags) == "+" else ""
                out.append("%" + flags.replace("+", zero) + fmt[j:k + 1])
        else:
            out.append(fmt[i:k + 1])
        i = k + 1
    return dt.strftime("".join(out))
