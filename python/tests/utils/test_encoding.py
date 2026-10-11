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

from mirage.utils.encoding import bom_of, decoder_for, encoding_for


@pytest.mark.parametrize(
    "label, name",
    [
        ("latin1", "windows-1252"),
        (" UTF-8 ", "UTF-8"),
        ("\tutf-16\n", "UTF-16LE"),
        ("SJIS", "Shift_JIS"),
        ("x-user-defined", "x-user-defined"),
    ],
)
def test_encoding_for_reads_a_label_as_the_standard_does(label, name):
    assert encoding_for(label) == name


# The replacement encoding's labels name none, as ripgrep looks them up
# (`rg -E iso-2022-kr` is an unknown encoding), and only ASCII case folds:
# the Kelvin sign lowercases to k.
@pytest.mark.parametrize(
    "label",
    [
        "utf16le",
        "replacement",
        "iso-2022-kr",
        "",
        chr(0x212A) + "oi8-r",
        "constructor",
    ],
)
def test_encoding_for_names_no_encoding(label):
    assert encoding_for(label) is None


def test_bom_of_names_the_mark_a_stream_starts_with():
    assert bom_of(b"\xef\xbb\xbfx") == (b"\xef\xbb\xbf", "UTF-8")
    assert bom_of(b"\xff\xfeh") == (b"\xff\xfe", "UTF-16LE")
    assert bom_of(b"\xfe\xff") == (b"\xfe\xff", "UTF-16BE")
    assert bom_of(b"\xef\xbb") is None


# Python's cp1252 leaves 0x81 unmapped and Node's TextDecoder reads
# windows-1252 as latin-1; the standard's table maps both bytes.
def test_a_single_byte_decoder_reads_the_standards_table():
    assert decoder_for("windows-1252")(b"\x80\x81\xe9", True) == (
        chr(0x20AC) + chr(0x81) + chr(0xE9)
    )
    assert decoder_for("ISO-8859-16")(b"\xa1", True) == chr(0x104)
    assert decoder_for("x-user-defined")(b"a\x80\xff", True) == (
        "a" + chr(0xF780) + chr(0xF7FF)
    )


def test_a_multibyte_decoder_streams_across_chunks():
    decode = decoder_for("UTF-16LE")
    assert decode(b"h\x00i", False) == "h"
    assert decode(b"\x00", False) == "i"
    assert decode(b"z", True) == chr(0xFFFD)
    decode = decoder_for("Shift_JIS")
    assert decode(b"\x93", False) + decode(b"\xfa", True) == "日"
