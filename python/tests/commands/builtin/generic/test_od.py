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

from mirage.commands.builtin.generic.od import parse_count
from mirage.commands.errors import UsageError


def test_decimal():
    assert parse_count("64", "-N") == 64


def test_strtol_base_0_hex_and_octal():
    # GNU od honors strtoumax base 0: 0x… is hex, a leading 0 is octal.
    assert parse_count("0x10", "-N") == 16
    assert parse_count("010", "-j") == 8
    assert parse_count("0", "-j") == 0


def test_size_suffixes():
    assert parse_count("3k", "-N") == 3072
    assert parse_count("1KiB", "-N") == 1024
    assert parse_count("1KB", "-N") == 1000
    assert parse_count("2b", "-N") == 1024
    assert parse_count("010K", "-N") == 8192


@pytest.mark.parametrize("value", ["abc", "", "x10"])
def test_junk_number_uses_invalid_argument_message(value):
    with pytest.raises(UsageError) as exc:
        parse_count(value, "-N")
    assert str(exc.value) == f"od: invalid -N argument '{value}'"
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("value", ["5c", "1g", "1t", "08", "0x"])
def test_junk_suffix_uses_invalid_suffix_message(value):
    # GNU distinguishes an unparseable number from an unknown suffix; 08
    # is octal-0 followed by the junk suffix "8", matching strtoumax.
    with pytest.raises(UsageError) as exc:
        parse_count(value, "-j")
    assert str(exc.value) == f"od: invalid suffix in -j argument '{value}'"


def test_uintmax_overflow_reports_too_large():
    # Q/R/Y/Z are in GNU's suffix set but always overflow uintmax.
    with pytest.raises(UsageError) as exc:
        parse_count("1Q", "-N")
    assert str(exc.value) == "od: -N argument '1Q' too large"
