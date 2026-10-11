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

import codecs
from collections.abc import Callable

from mirage.utils.generated.encoding_data import ENCODING_LABELS, SINGLE_BYTE

# The byte-order marks, each with the encoding it names.
BOMS = (
    (b"\xef\xbb\xbf", "UTF-8"),
    (b"\xff\xfe", "UTF-16LE"),
    (b"\xfe\xff", "UTF-16BE"),
)

# The codec each encoding no SINGLE_BYTE table holds decodes with. GBK
# decodes as gb18030 does, as the standard says; Python's codecs leave a
# few bytes unmapped that the standard maps (gb18030's 0x80 is the euro
# sign), and the reverse (cp932 maps 0xA0 and 0xFD-0xFF to private use).
DECODERS = {
    "UTF-8": "utf-8",
    "UTF-16LE": "utf-16-le",
    "UTF-16BE": "utf-16-be",
    "GBK": "gb18030",
    "gb18030": "gb18030",
    "Big5": "big5hkscs",
    "EUC-JP": "euc_jp",
    "ISO-2022-JP": "iso2022_jp",
    "Shift_JIS": "cp932",
    "EUC-KR": "cp949",
}

_ASCII_WHITESPACE = "\t\n\f\r "


def encoding_for(label: str) -> str | None:
    """The WHATWG encoding a label names, or None.

    Surrounding ASCII whitespace is dropped and ASCII case ignored, as
    the standard's get-an-encoding reads a label. The replacement
    encoding's labels name none.

    Args:
        label (str): the label as typed.
    """
    trimmed = label.strip(_ASCII_WHITESPACE)
    if not trimmed.isascii():
        return None
    return ENCODING_LABELS.get(trimmed.lower())


def bom_of(data: bytes) -> tuple[bytes, str] | None:
    """The byte-order mark ``data`` starts with and the encoding it names.

    Args:
        data (bytes): the first bytes of a stream, three or all of them.
    """
    for mark, name in BOMS:
        if data.startswith(mark):
            return mark, name
    return None


def decoder_for(encoding: str) -> Callable[[bytes, bool], str]:
    """A streaming decoder for a WHATWG encoding: call it with each chunk
    and whether it is the last. A byte sequence the encoding does not map
    decodes to U+FFFD. A single-byte encoding reads its table, so both
    hosts decode it exactly as the standard does.

    Args:
        encoding (str): the encoding's WHATWG name.
    """
    table = SINGLE_BYTE.get(encoding)
    if table is None:
        return codecs.getincrementaldecoder(DECODERS[encoding])(
            "replace"
        ).decode
    high = {0x80 + offset: point for offset, point in enumerate(table)}
    return lambda data, last: data.decode("latin-1").translate(high)
