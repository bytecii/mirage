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

from mirage.shell.bytes import encode_text
from mirage.workspace.executor.builtins.echo import interpret_escapes


@pytest.mark.parametrize(
    "text, expected",
    [
        pytest.param("a\\nb", ("a\nb", False), id="newline"),
        pytest.param("a\\tb", ("a\tb", False), id="tab"),
        pytest.param("\\r", ("\r", False), id="carriage_return"),
        pytest.param("\\a", ("\x07", False), id="bell"),
        pytest.param("\\b", ("\x08", False), id="backspace"),
        pytest.param("\\f", ("\x0c", False), id="form_feed"),
        pytest.param("\\v", ("\x0b", False), id="vertical_tab"),
        pytest.param("a\\\\b", ("a\\b", False), id="literal_backslash"),
        pytest.param("\\\\n", ("\\n", False), id="double_backslash_before_n"),
        pytest.param("\\x41", ("A", False), id="hex_escape"),
        pytest.param("\\x9", ("\t", False), id="hex_single_digit"),
        pytest.param("\\x", ("\\x", False), id="hex_no_digits"),
        pytest.param("\\0101", ("A", False), id="octal_escape"),
        pytest.param("\\0", ("\x00", False), id="octal_null"),
        pytest.param("hello\\cworld", ("hello", True), id="stop_output"),
        pytest.param("\\z", ("\\z", False), id="unknown_escape_passthrough"),
        pytest.param("hello world", ("hello world", False), id="no_escapes"),
        pytest.param("", ("", False), id="empty"),
        pytest.param("end\\", ("end\\", False), id="trailing_backslash"),
        pytest.param("a\\tb\\nc\\\\d", ("a\tb\nc\\d", False), id="mixed"),
    ],
)
def test_interpret_escapes(text, expected):
    assert interpret_escapes(text) == expected


# Pinned against bash 5.2.37 in docker (debian:stable-slim,
# LC_ALL=C.UTF-8): echo -e '<text>' | od -An -tx1.


def test_e_and_capital_e_are_esc():
    assert interpret_escapes("a\\eb\\Ec") == ("a\x1bb\x1bc", False)


def test_esc_at_the_end_of_the_text():
    assert interpret_escapes("a\\e") == ("a\x1b", False)
    assert interpret_escapes("a\\E") == ("a\x1b", False)


def test_esc_before_stop():
    assert interpret_escapes("a\\E\\cb") == ("a\x1b", True)
    assert interpret_escapes("a\\E\\c") == ("a\x1b", True)


def test_stop_before_esc():
    assert interpret_escapes("a\\c\\Eb") == ("a", True)


def test_double_backslash_before_e():
    assert interpret_escapes("\\\\e\\\\E") == ("\\e\\E", False)


def test_unicode_escape_is_a_code_point():
    assert interpret_escapes("\\u00e9") == ("é", False)
    assert interpret_escapes("\\U0001F600") == ("\U0001f600", False)


def test_unicode_escape_reads_at_most_its_digits():
    assert interpret_escapes("\\u0041B") == ("AB", False)
    assert interpret_escapes("\\u41") == ("A", False)
    assert interpret_escapes("\\U41") == ("A", False)


def test_unicode_escape_without_digits_is_literal():
    assert interpret_escapes("\\u") == ("\\u", False)
    assert interpret_escapes("\\ug") == ("\\ug", False)
    assert interpret_escapes("\\U") == ("\\U", False)


def test_unicode_nul_is_written():
    assert interpret_escapes("a\\u0000b") == ("a\0b", False)


def test_unicode_escape_outside_unicode_is_utf8_shaped():
    assert encode_text(interpret_escapes("\\uD800")[0]) == b"\xed\xa0\x80"
    assert (
        encode_text(interpret_escapes("\\U00110000")[0]) == b"\xf4\x90\x80\x80"
    )
    assert interpret_escapes("\\UFFFFFFFF") == ("", False)
