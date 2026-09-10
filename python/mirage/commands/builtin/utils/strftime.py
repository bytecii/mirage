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

import math
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


def pad_signed(sign: str, digits: str, pad: str | None,
               width: int | None) -> str:
    """Pad a signed number the way GNU date pads one: zeros go after the
    sign (``%3s`` of -1 is ``-01``, ``%8:z`` is ``+0005:30``), spaces
    before it (``%_3s`` is ``" -1"``), and ``-`` pads nothing.

    Args:
        sign (str): ``-``, ``+`` or empty.
        digits (str): the magnitude.
        pad (str | None): the winning padding flag, None for a bare width.
        width (int | None): the width the digits fill, None for none.
    """
    if pad == "-" or width is None or width <= len(digits):
        return sign + digits
    if pad == "_":
        return " " * (width - len(digits)) + sign + digits
    return sign + digits.rjust(width, "0")


def zone_offset(dt: datetime, colons: int, flags: str,
                width: int | None) -> str:
    """Render ``%z`` and its colon forms as GNU date does: ``%:z`` is
    ``+05:30``, ``%::z`` adds seconds, ``%:::z`` keeps only the parts
    that are not zero (``+05``, ``+05:30``). The flags and width pad the
    hours field with the width covering the whole (``%_:z`` is
    ``" +5:30"``, ``%8:z`` is ``+0005:30``, ``%-z`` is ``+530``). A naive
    moment is taken as local time, as ``%s`` takes it.

    Args:
        dt (datetime): the moment being rendered.
        colons (int): how many colons were typed before ``z``.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    offset = dt.utcoffset()
    if offset is None:
        offset = dt.astimezone().utcoffset()
    total = round(offset.total_seconds()) if offset is not None else 0
    sign = "-" if total < 0 else "+"
    hours, rest = divmod(abs(total), 3600)
    minutes, seconds = divmod(rest, 60)
    if colons == 0:
        tail = f"{minutes:02d}"
    elif colons == 1 or (colons == 3 and minutes and not seconds):
        tail = f":{minutes:02d}"
    elif colons == 2 or seconds:
        tail = f":{minutes:02d}:{seconds:02d}"
    else:
        tail = ""
    digits = 2 if width is None else width - len(tail) - 1
    return pad_signed(sign, str(hours), winning_pad(flags), digits) + tail


def epoch_seconds(dt: datetime, flags: str, width: int | None) -> str:
    """Render ``%s`` as GNU date does, padding a negative value after
    its sign (``%3s`` of -1 is ``-01``, ``%_5s`` is ``"   -1"``).

    Args:
        dt (datetime): the moment being rendered.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    value = math.floor(dt.timestamp())
    sign = "-" if value < 0 else ""
    digits = None if width is None else width - len(sign)
    return pad_signed(sign, str(abs(value)), winning_pad(flags), digits)


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
    flag outranks is dropped. ``%z`` and its colon forms ``%:z``,
    ``%::z`` and ``%:::z`` are rendered here too (``zone_offset``), as
    is ``%s`` (``epoch_seconds``), since neither C library pads a
    negative number or an offset the way GNU does. A colon before any
    other directive stays literal, as in GNU. Every other directive
    passes to strftime with its prefix intact; ``%%`` pairs are stepped
    over, keeping ``%%q`` literal.

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
        c = k
        while c < len(fmt) and fmt[c] == ":":
            c += 1
        if c >= len(fmt):
            out.append("%%" + fmt[i + 1:])
            break
        width = int(fmt[j:k]) if k > j else None
        directive = fmt[c]
        if directive == "z":
            out.append(zone_offset(dt, c - k, fmt[i + 1:j], width))
        elif c > k:
            out.append("%%" + fmt[i + 1:c + 1])
        elif directive == "s":
            out.append(epoch_seconds(dt, fmt[i + 1:j], width))
        elif directive == "q":
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
        i = c + 1
    return dt.strftime("".join(out))
