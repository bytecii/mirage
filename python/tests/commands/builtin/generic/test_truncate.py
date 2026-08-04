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

from mirage.commands.builtin.generic.truncate import parse_size
from mirage.commands.errors import UsageError


def test_plain_and_operation_sizes():
    assert parse_size("10", 0) == 10
    assert parse_size("+2", 10) == 12
    assert parse_size("-4", 10) == 6
    assert parse_size("%4", 10) == 12
    assert parse_size("/4", 10) == 8


def test_full_gnu_suffix_alphabet():
    # truncate's letter set is not split's: lowercase g/k/m/t are valid
    # (pinned against coreutils 9.7), and E/P parse fine even though most
    # filesystems refuse the resulting size.
    assert parse_size("1k", 0) == 1024
    assert parse_size("1g", 0) == 1024**3
    assert parse_size("1t", 0) == 1024**4
    assert parse_size("1G", 0) == 1024**3
    assert parse_size("1GiB", 0) == 1024**3
    assert parse_size("1GB", 0) == 1000**3
    assert parse_size("1mB", 0) == 1000**2
    assert parse_size("1E", 0) == 1024**6


@pytest.mark.parametrize("value", ["abc", "", "1x1K", "2b", "5c", "1e"])
def test_junk_is_invalid_number(value):
    with pytest.raises(UsageError) as exc:
        parse_size(value, 0)
    assert str(exc.value) == f"truncate: Invalid number: '{value}'"
    assert exc.value.exit_code == 1


def test_off_t_overflow_appends_value_too_large():
    with pytest.raises(UsageError) as exc:
        parse_size("1Z", 0)
    assert str(exc.value) == ("truncate: Invalid number: '1Z': "
                              "Value too large for defined data type")


def test_division_by_zero():
    with pytest.raises(UsageError) as exc:
        parse_size("/0", 10)
    assert str(exc.value) == "truncate: division by zero"
