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

from mirage.commands.builtin.generic.split import (parse_bytes_value,
                                                   parse_chunks_value,
                                                   parse_lines_value,
                                                   parse_suffix_length,
                                                   parse_suffix_start)
from mirage.commands.errors import UsageError

_TRY = "\nTry 'split --help' for more information."


def test_bytes_accepts_gnu_suffixes():
    assert parse_bytes_value("4") == 4
    assert parse_bytes_value("1k") == 1024
    assert parse_bytes_value("1kB") == 1000
    assert parse_bytes_value("1KiB") == 1024
    assert parse_bytes_value("2b") == 1024
    assert parse_bytes_value("1G") == 1024**3
    # split is base-10 only: a leading zero is not octal.
    assert parse_bytes_value("010") == 10


@pytest.mark.parametrize("value",
                         ["abc", "", "1x1b", "0x10", "0", "0K", "1g", "5c"])
def test_bytes_rejects_junk_zero_and_foreign_radix(value):
    with pytest.raises(UsageError) as exc:
        parse_bytes_value(value)
    assert str(exc.value) == f"split: invalid number of bytes: '{value}'"
    assert exc.value.exit_code == 1


def test_lines_rejects_junk_zero_and_suffixes():
    assert parse_lines_value("3") == 3
    for value in ["abc", "0", "1k"]:
        with pytest.raises(UsageError) as exc:
            parse_lines_value(value)
        assert str(exc.value) == f"split: invalid number of lines: '{value}'"


def test_chunks_quotes_only_the_count_of_a_spec():
    assert parse_chunks_value("4") == 4
    assert parse_chunks_value("l/4") == 4
    with pytest.raises(UsageError) as exc:
        parse_chunks_value("l/abc")
    assert str(exc.value) == "split: invalid number of chunks: 'abc'"
    with pytest.raises(UsageError) as exc:
        parse_chunks_value("l/0")
    assert str(exc.value) == "split: invalid number of chunks: '0'"


def test_suffix_length_rejects_junk_but_allows_zero():
    assert parse_suffix_length("3") == 3
    assert parse_suffix_length("0") == 0
    with pytest.raises(UsageError) as exc:
        parse_suffix_length("1k")
    assert str(exc.value) == "split: invalid suffix length: '1k'"


def test_suffix_start_parses_hex_in_hex_mode():
    assert parse_suffix_start("07", False, 2) == 7
    assert parse_suffix_start("007", False, 2) == 7
    assert parse_suffix_start("10", True, 2) == 16
    assert parse_suffix_start("ff", True, 2) == 255


def test_suffix_start_junk_and_width_overflow():
    with pytest.raises(UsageError) as exc:
        parse_suffix_start("zz", False, 2)
    assert str(exc.value) == ("split: 'zz': invalid start value "
                              "for numerical suffix" + _TRY)
    with pytest.raises(UsageError) as exc:
        parse_suffix_start("100", False, 2)
    assert str(exc.value) == ("split: numerical suffix start value is "
                              "too large for the suffix length" + _TRY)


def test_suffix_start_hex_junk_says_hexadecimal():
    with pytest.raises(UsageError) as exc:
        parse_suffix_start("zz", True, 2)
    assert str(exc.value) == ("split: 'zz': invalid start value "
                              "for hexadecimal suffix" + _TRY)
