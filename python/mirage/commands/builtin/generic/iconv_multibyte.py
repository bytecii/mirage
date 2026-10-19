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

import itertools
import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from mirage.utils.generated.iconv_data import (
    ICONV_EXCLUDED,
    ICONV_ONE_WAY,
    ICONV_REMAPPED,
)

logger = logging.getLogger(__name__)

ILLEGAL = -1
CUT = -2

# One decoded character as (code point, bytes used); the code point is
# ILLEGAL or CUT when there is none.
Decoded = tuple[int, int]
Table = dict[int, int]
ByteRanges = tuple[tuple[int, int], ...]
Block = tuple[ByteRanges, ...]
StepFn = Callable[[bytes, int, Table], Decoded]

GBK_TRAIL: ByteRanges = ((0x40, 0x7E), (0x80, 0xFE))
SJIS_TRAIL: ByteRanges = ((0x40, 0x7E), (0x80, 0xFC))
EUC_BYTE: ByteRanges = ((0xA1, 0xFE),)
FOUR_DIGIT: ByteRanges = ((0x30, 0x39),)
FOUR_LETTER: ByteRanges = ((0x81, 0xFE),)
PRIVATE_USE = (0xE000, 0xF8FF)
HALFWIDTH_KATAKANA = 0xFEC0
SUPPLEMENTARY_LEAD = (0x90, 0xE3)
LAST_CODE_POINT = 0x10FFFF


def _key(raw: bytes, at: int, width: int) -> int:
    return int.from_bytes(raw[at : at + width], "big")


def _width(key: int) -> int:
    """How many bytes a sequence spans, one to four.

    Args:
        key (int): a sequence read big-endian.
    """
    if key > 0xFFFF:
        return 4 if key > 0xFFFFFF else 3
    return 2 if key > 0xFF else 1


def _pair(raw: bytes, at: int, table: Table, unmapped: int) -> Decoded:
    cp = table.get(_key(raw, at, 2))
    return (cp, 2) if cp is not None else (ILLEGAL, unmapped)


def gbk_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One GBK character, by the byte grammar measured from glibc 2.41.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte table.
    """
    lead = raw[at]
    if lead < 0x80:
        return lead, 1
    if lead == 0x80:
        return 0x20AC, 1
    if lead == 0xFF:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    trail = raw[at + 1]
    if trail < 0x40 or trail == 0xFF or (lead == 0xFE and trail > 0xA0):
        return ILLEGAL, 1
    return _pair(raw, at, table, 2)


def euc_cn_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One EUC-CN (GB2312) character, by the byte grammar measured from glibc.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte table.
    """
    lead = raw[at]
    if lead < 0x80:
        return lead, 1
    if (lead <= 0xA0 and lead not in (0x8E, 0x8F)) or lead == 0xFF:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    if raw[at + 1] < 0xA1:
        return ILLEGAL, 1
    return _pair(raw, at, table, 2)


def euc_kr_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One EUC-KR character, by the byte grammar measured from glibc.

    Bytes up to 0x9F stand for themselves, C1 controls included, and
    a refused pair is skipped whole whatever its second byte is.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte table.
    """
    lead = raw[at]
    if lead <= 0x9F:
        return lead, 1
    if lead == 0xA0:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    return _pair(raw, at, table, 2)


def sjis_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One Shift_JIS character, by the byte grammar measured from glibc.

    glibc reads 0x5C as YEN SIGN and 0x7E as OVERLINE, JIS X 0201's
    Roman half, and 0xA1-0xDF as half-width katakana.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte table.
    """
    lead = raw[at]
    if lead == 0x5C:
        return 0xA5, 1
    if lead == 0x7E:
        return 0x203E, 1
    if lead < 0x80:
        return lead, 1
    if 0xA1 <= lead <= 0xDF:
        return lead + HALFWIDTH_KATAKANA, 1
    if lead in (0x80, 0xA0) or lead > 0xEA:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    if raw[at + 1] < 0x40:
        return ILLEGAL, 1
    return _pair(raw, at, table, 2)


def euc_jp_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One EUC-JP character, by the byte grammar measured from glibc.

    Code set 2 (0x8E) is half-width katakana and code set 3 (0x8F)
    JIS X 0212, whose rows outside 0x22-0x6D glibc refuses before it
    asks for the third byte. glibc skips one byte of any refused
    sequence.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two- and three-byte table.
    """
    lead = raw[at]
    if lead < 0x8E or 0x90 <= lead <= 0x9F:
        return lead, 1
    if lead == 0xFF:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    second = raw[at + 1]
    if second < 0xA1:
        return ILLEGAL, 1
    if lead == 0x8F:
        if not 0xA2 <= second <= 0xED:
            return ILLEGAL, 1
        if at + 2 >= len(raw):
            return CUT, 0
        cp = table.get(_key(raw, at, 3))
        return (cp, 3) if cp is not None else (ILLEGAL, 1)
    return _pair(raw, at, table, 1)


def _supplementary(raw: bytes, at: int) -> int | None:
    """The code point of a GB18030 four-byte sequence past the BMP.

    Planes 1-16 are a straight count from 0x90308130.

    Args:
        raw (bytes): the input.
        at (int): offset of the sequence.
    """
    b1, b2, b3, b4 = raw[at : at + 4]
    index = (((b1 - 0x90) * 10 + (b2 - 0x30)) * 126 + (b3 - 0x81)) * 10
    cp = 0x10000 + index + (b4 - 0x30)
    return cp if cp <= LAST_CODE_POINT else None


def gb18030_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One GB18030 character, by the byte grammar measured from glibc.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte and BMP four-byte table.
    """
    lead = raw[at]
    if lead < 0x80:
        return lead, 1
    if lead in (0x80, 0xFF):
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    second = raw[at + 1]
    if 0x30 <= second <= 0x39:
        if at + 3 >= len(raw):
            return CUT, 0
        if not 0x81 <= raw[at + 2] <= 0xFE:
            return ILLEGAL, 3
        if not 0x30 <= raw[at + 3] <= 0x39:
            return ILLEGAL, 4
        if SUPPLEMENTARY_LEAD[0] <= lead <= SUPPLEMENTARY_LEAD[1]:
            cp = _supplementary(raw, at)
        else:
            cp = table.get(_key(raw, at, 4))
        return (cp, 4) if cp is not None else (ILLEGAL, 4)
    if second < 0x40 or second in (0x7F, 0xFF):
        return ILLEGAL, 2
    return _pair(raw, at, table, 2)


@dataclass(frozen=True, slots=True)
class MultibyteSpec:
    """One multi-byte charset: its byte grammar over a host-seeded table.

    The table is what the host's own decoder (a python codec here, the
    platform ``TextDecoder`` in TypeScript) answers for every sequence
    in ``blocks``, corrected to the charset's standard mapping table:
    ``remapped`` sets the sequences where a host disagrees with it,
    ``excluded`` drops the ranges a host decodes and it leaves unmapped,
    and a private-use answer is dropped unless the standard maps into
    that area. scripts/gen_iconv_multibyte.py derives the corrections
    from the published tables for CPython's codecs, ICU's (Node) and
    WHATWG's (browsers), so every host builds the same table, and the
    pinned image's iconv agrees with it byte for byte. A sequence is
    its bytes read big-endian.

    Args:
        name (str): the charset, as ``iconv -l`` names it.
        codec (str): the host decoder that seeds the table.
        step (StepFn): reads one character.
        blocks (tuple[Block, ...]): the sequences the table holds, as
            per-byte ranges.
        remapped (tuple[tuple[int, int], ...]): sequence, the standard's
            code point.
        excluded (tuple[tuple[int, int], ...]): first and last sequence
            of a range the standard leaves unmapped.
        private_use (bool): whether the standard maps sequences into
            U+E000-F8FF.
        one_way (tuple[tuple[int, int], ...]): code points iconv encodes
            to a sequence that decodes to another one, and that sequence.
        supplementary (bool): whether planes 1-16 are counted out by
            four-byte sequences (GB18030).
    """

    name: str
    codec: str
    step: StepFn
    blocks: tuple[Block, ...]
    remapped: tuple[tuple[int, int], ...] = ()
    excluded: tuple[tuple[int, int], ...] = ()
    private_use: bool = False
    one_way: tuple[tuple[int, int], ...] = ()
    supplementary: bool = False


GBK = MultibyteSpec(
    name="GBK",
    codec="gbk",
    step=gbk_step,
    blocks=(
        (((0x81, 0xFD),), GBK_TRAIL),
        (((0xFE, 0xFE),), ((0x40, 0x7E), (0x80, 0xA0))),
    ),
    remapped=ICONV_REMAPPED["GBK"],
    excluded=ICONV_EXCLUDED["GBK"],
    one_way=ICONV_ONE_WAY["GBK"],
)

EUC_CN = MultibyteSpec(
    name="EUC-CN",
    codec="gb2312",
    step=euc_cn_step,
    blocks=((((0xA1, 0xF7),), EUC_BYTE),),
    remapped=ICONV_REMAPPED["EUC-CN"],
    excluded=ICONV_EXCLUDED["EUC-CN"],
    one_way=ICONV_ONE_WAY["EUC-CN"],
)

GB18030 = MultibyteSpec(
    name="GB18030",
    codec="gb18030",
    step=gb18030_step,
    blocks=(
        (FOUR_LETTER, GBK_TRAIL),
        (((0x81, 0x83),), FOUR_DIGIT, FOUR_LETTER, FOUR_DIGIT),
        (((0x84, 0x84),), ((0x30, 0x30),), FOUR_LETTER, FOUR_DIGIT),
        (((0x84, 0x84),), ((0x31, 0x31),), ((0x81, 0xA4),), FOUR_DIGIT),
    ),
    private_use=True,
    supplementary=True,
    remapped=ICONV_REMAPPED["GB18030"],
    excluded=ICONV_EXCLUDED["GB18030"],
    one_way=ICONV_ONE_WAY["GB18030"],
)

EUC_KR = MultibyteSpec(
    name="EUC-KR",
    codec="euc_kr",
    step=euc_kr_step,
    blocks=((EUC_BYTE, EUC_BYTE),),
    remapped=ICONV_REMAPPED["EUC-KR"],
    excluded=ICONV_EXCLUDED["EUC-KR"],
    one_way=ICONV_ONE_WAY["EUC-KR"],
)

SJIS = MultibyteSpec(
    name="SJIS",
    codec="shift_jis",
    step=sjis_step,
    blocks=(
        (((0x81, 0x9F),), SJIS_TRAIL),
        (((0xE0, 0xEA),), SJIS_TRAIL),
    ),
    remapped=ICONV_REMAPPED["SJIS"],
    excluded=ICONV_EXCLUDED["SJIS"],
    one_way=ICONV_ONE_WAY["SJIS"],
)

EUC_JP = MultibyteSpec(
    name="EUC-JP",
    codec="euc_jp",
    step=euc_jp_step,
    blocks=(
        (EUC_BYTE, EUC_BYTE),
        (((0x8E, 0x8E),), ((0xA1, 0xDF),)),
        (((0x8F, 0x8F),), ((0xA2, 0xED),), EUC_BYTE),
    ),
    remapped=ICONV_REMAPPED["EUC-JP"],
    excluded=ICONV_EXCLUDED["EUC-JP"],
    one_way=ICONV_ONE_WAY["EUC-JP"],
)

MULTIBYTE_CHARSETS: dict[str, MultibyteSpec] = {
    "GBK": GBK,
    "GB13000": GBK,
    "CP936": GBK,
    "MS936": GBK,
    "WINDOWS-936": GBK,
    "EUC-CN": EUC_CN,
    "EUCCN": EUC_CN,
    "GB2312": EUC_CN,
    "CSGB2312": EUC_CN,
    "CN-GB": EUC_CN,
    "GB18030": GB18030,
    "EUC-KR": EUC_KR,
    "EUCKR": EUC_KR,
    "CSEUCKR": EUC_KR,
    "OSF0004000A": EUC_KR,
    "SJIS": SJIS,
    "SHIFT-JIS": SJIS,
    "SHIFT_JIS": SJIS,
    "MS_KANJI": SJIS,
    "CSSHIFTJIS": SJIS,
    "EUC-JP": EUC_JP,
    "EUCJP": EUC_JP,
    "UJIS": EUC_JP,
    "CSEUCPKDFMTJAPANESE": EUC_JP,
    "OSF00030010": EUC_JP,
}


def _sequences(blocks: tuple[Block, ...]) -> Iterator[bytes]:
    """Every sequence the blocks span, in block then byte order.

    Args:
        blocks (tuple[Block, ...]): per-byte ranges.
    """
    for block in blocks:
        axes = [
            [x for low, high in ranges for x in range(low, high + 1)]
            for ranges in block
        ]
        yield from (bytes(combo) for combo in itertools.product(*axes))


_TABLES: dict[str, Table] = {}
_REVERSES: dict[str, dict[int, bytes]] = {}


def multibyte_table(spec: MultibyteSpec) -> Table:
    """The sequence-to-code-point table of a charset, built once.

    Args:
        spec (MultibyteSpec): the charset.
    """
    known = _TABLES.get(spec.name)
    if known is not None:
        return known
    table: Table = {}
    refused = 0
    first_error: UnicodeDecodeError | None = None
    for seq in _sequences(spec.blocks):
        key = int.from_bytes(seq, "big")
        if any(low <= key <= high for low, high in spec.excluded):
            continue
        try:
            text = seq.decode(spec.codec)
        except UnicodeDecodeError as exc:
            refused += 1
            if first_error is None:
                first_error = exc
            continue
        if len(text) != 1:
            continue
        cp = ord(text)
        if not spec.private_use and PRIVATE_USE[0] <= cp <= PRIVATE_USE[1]:
            continue
        table[key] = cp
    if first_error is not None:
        logger.debug(
            "iconv: %s table skipped %d undecodable sequences; first: %s",
            spec.codec,
            refused,
            first_error,
        )
    for key, cp in spec.remapped:
        table[key] = cp
    _TABLES[spec.name] = table
    return table


def multibyte_reverse(spec: MultibyteSpec) -> dict[int, bytes]:
    """The code-point-to-sequence table glibc encodes with.

    It is the decode table turned around, single bytes included, plus
    glibc's one-way entries. No supported charset decodes two sequences
    to one code point, so the order the entries are added in decides
    nothing.

    Args:
        spec (MultibyteSpec): the charset.
    """
    known = _REVERSES.get(spec.name)
    if known is not None:
        return known
    table = multibyte_table(spec)
    reverse: dict[int, bytes] = {}
    for seq in (bytes([byte]) for byte in range(0x100)):
        cp, width = spec.step(seq, 0, table)
        if cp >= 0 and width == 1:
            reverse.setdefault(cp, seq)
    for key, cp in table.items():
        reverse.setdefault(cp, key.to_bytes(_width(key), "big"))
    for cp, key in spec.one_way:
        reverse[cp] = key.to_bytes(_width(key), "big")
    _REVERSES[spec.name] = reverse
    return reverse


def _supplementary_sequence(cp: int) -> bytes:
    """The GB18030 four-byte sequence of a code point past the BMP.

    Args:
        cp (int): a code point from U+10000.
    """
    index = cp - 0x10000
    index, b4 = divmod(index, 10)
    index, b3 = divmod(index, 126)
    b1, b2 = divmod(index, 10)
    return bytes([0x90 + b1, 0x30 + b2, 0x81 + b3, 0x30 + b4])


class MultibyteEncoder:
    """The target side of a multi-byte charset, shared by every input.

    Mirrors the TypeScript ``MultibyteEncoder``.
    """

    def __init__(self, spec: MultibyteSpec) -> None:
        self.spec = spec
        self.reverse = multibyte_reverse(spec)

    def encode_char(self, cp: int) -> bytes | None:
        seq = self.reverse.get(cp)
        if seq is None and self.spec.supplementary and cp >= 0x10000:
            return _supplementary_sequence(cp)
        return seq

    def encode_text(self, text: str) -> bytes | None:
        out = bytearray()
        for char in text:
            seq = self.encode_char(ord(char))
            if seq is None:
                return None
            out += seq
        return bytes(out)


__all__ = [
    "CUT",
    "EUC_CN",
    "EUC_JP",
    "EUC_KR",
    "GB18030",
    "GBK",
    "ILLEGAL",
    "MULTIBYTE_CHARSETS",
    "SJIS",
    "MultibyteEncoder",
    "MultibyteSpec",
    "multibyte_reverse",
    "multibyte_table",
]
