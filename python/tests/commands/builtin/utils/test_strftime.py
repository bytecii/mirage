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

import pytest

from mirage.commands.builtin.utils.strftime import gnu_strftime

MOMENT = datetime(2026, 1, 1, 0, 0, 1, 123456)


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
