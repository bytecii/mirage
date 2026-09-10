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

from datetime import datetime, timedelta, timezone

import pytest

from mirage.commands.builtin.utils.strftime import gnu_strftime

MOMENT = datetime(2026, 1, 1, 0, 0, 1, 123456)
ZONED = datetime(1970, 1, 1, tzinfo=timezone(timedelta(hours=5, minutes=30)))
BEFORE_EPOCH = datetime.fromtimestamp(-1, timezone.utc)
NARROW = datetime(2026, 1, 3, 5, 7, 9, tzinfo=timezone.utc)


@pytest.mark.parametrize("fmt,expected", [
    ("%N", "123456000"),
    ("%3N", "123"),
    ("%-N", "123456000"),
    ("%_3N", "123"),
    ("%03N", "123"),
    ("%6N", "123456"),
    ("%12N", "123456000000"),
    ("%q", "1"),
    ("%2q", "01"),
    ("%02q", "01"),
    ("%_2q", " 1"),
    ("%+2q", "01"),
    ("%+5Y", "+2026"),
    ("%+12F", "+02026-01-01"),
    ("%+5F", "2026-01-01"),
    ("%+4Y", "2026"),
    ("%+6Y", "+02026"),
    ("%+3Y", "2026"),
    ("%+5G", "+2026"),
    ("%+3C", "+20"),
    ("%+C", "20"),
    ("%0+5Y", "+2026"),
    ("%-+5Y", "+2026"),
    ("%-2q", "1"),
    ("%_3q", "  1"),
    ("%_q", "1"),
    ("%_-2q", "1"),
    ("%-_2q", " 1"),
    ("%0_2q", " 1"),
    ("%_02q", "01"),
    ("%^_2q", " 1"),
    ("%%N", "%N"),
    ("%%q", "%q"),
    ("%Y/%q/%3N", "2026/1/123"),
])
def test_gnu_directives_follow_date(fmt: str, expected: str):
    # Pinned against date 9.7: a width on %N keeps that many leading
    # digits and pads a wider one with zeros on the right and its flags
    # change nothing; a width on %q pads on the left, with zeros unless
    # `_` says spaces or `-` says none, the last of the three winning.
    assert gnu_strftime(MOMENT, fmt) == expected


@pytest.mark.parametrize("fmt,expected", [
    ("%:z", "+05:30"),
    ("%::z", "+05:30:00"),
    ("%:::z", "+05:30"),
    ("%z", "+0530"),
    ("%_:z", " +5:30"),
    ("%-:z", "+5:30"),
    ("%0:z", "+05:30"),
    ("%5:z", "+5:30"),
    ("%8:z", "+0005:30"),
    ("%_8:z", "   +5:30"),
    ("%-8:z", "+5:30"),
    ("%^:z", "+05:30"),
    ("%_z", " +530"),
    ("%-z", "+530"),
    ("%6z", "+00530"),
    ("%_6z", "  +530"),
    ("%8::z", "+5:30:00"),
    ("%_:::z", " +5:30"),
    ("%:q", "%:q"),
    ("%:%z", "%:+0530"),
    ("%::", "%::"),
])
def test_zone_offsets_follow_date(fmt: str, expected: str):
    # Pinned against date 9.7: the colon forms of %z, whose flags and
    # width pad the hours with the width covering the whole field; a
    # colon before any other directive stays literal.
    assert gnu_strftime(ZONED, fmt) == expected


@pytest.mark.parametrize("fmt,expected", [
    ("%:::z", "+00"),
    ("%_:::z", " +0"),
    ("%5:::z", "+0000"),
    ("%3s", "-01"),
    ("%s", "-1"),
    ("%_3s", " -1"),
    ("%-3s", "-1"),
    ("%03s", "-01"),
    ("%+3s", "-01"),
    ("%5s", "-0001"),
    ("%_5s", "   -1"),
])
def test_negative_numbers_pad_after_the_sign(fmt: str, expected: str):
    # Pinned against date 9.7: zeros go after the sign, spaces before it.
    assert gnu_strftime(BEFORE_EPOCH, fmt) == expected
    assert gnu_strftime(datetime.fromtimestamp(-100, timezone.utc),
                        "%5s|%_5s|%2s") == "-0100| -100|-100"


@pytest.mark.parametrize("fmt,expected", [
    ("%1d", "3"),
    ("%2d", "03"),
    ("%3d", "003"),
    ("%_3d", "  3"),
    ("%-3d", "3"),
    ("%03d", "003"),
    ("%1j", "3"),
    ("%2j", "03"),
    ("%4j", "0003"),
    ("%1e", "3"),
    ("%3e", "  3"),
    ("%_1e", "3"),
    ("%03e", "003"),
    ("%-e", "3"),
    ("%0e", "03"),
    ("%_e", " 3"),
    ("%1Y", "2026"),
    ("%5Y", "02026"),
    ("%1y", "26"),
    ("%1m", "1"),
    ("%_m", " 1"),
    ("%1H", "5"),
    ("%1M", "7"),
    ("%1S", "9"),
    ("%1k", "5"),
    ("%3k", "  5"),
    ("%1l", "5"),
    ("%1u", "6"),
    ("%3u", "006"),
    ("%1w", "6"),
    ("%1U", "0"),
    ("%1W", "0"),
    ("%1V", "1"),
    ("%1C", "20"),
    ("%1g", "26"),
    ("%1G", "2026"),
    ("%1I", "5"),
    ("%+5d", "00003"),
    ("%+1d", "3"),
    ("%+3e", "003"),
    ("%^3d", "003"),
    ("%#3d", "003"),
    ("%-d", "3"),
    ("%-_3d", "  3"),
    ("%_-3d", "3"),
])
def test_widths_replace_the_default_digits(fmt: str, expected: str):
    # Pinned against date 9.7: a width on a numeric directive replaces
    # its default padding rather than adding to it, and %e, %k and %l
    # fill with spaces where the rest fill with zeros.
    assert gnu_strftime(NARROW, fmt) == expected


def test_naive_moment_takes_the_local_zone():
    off = MOMENT.astimezone().strftime("%z")
    assert gnu_strftime(MOMENT, "%:z") == off[:3] + ":" + off[3:]
