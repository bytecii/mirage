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

from mirage.utils.generated.iconv_data import (
    ICONV_EXCLUDED,
    ICONV_ONE_WAY,
    ICONV_REMAPPED,
)

CHARSETS = {"GBK", "EUC-CN", "GB18030", "EUC-KR", "SJIS", "EUC-JP"}


def test_every_table_covers_the_same_charsets():
    assert set(ICONV_REMAPPED) == CHARSETS
    assert set(ICONV_EXCLUDED) == CHARSETS
    assert set(ICONV_ONE_WAY) == CHARSETS


def test_each_sequence_and_code_point_is_listed_once_in_order():
    for table in (ICONV_REMAPPED, ICONV_ONE_WAY):
        for pairs in table.values():
            keys = [key for key, _ in pairs]
            assert keys == sorted(set(keys))
    for ranges in ICONV_EXCLUDED.values():
        assert all(first <= last for first, last in ranges)
        assert all(a[1] < b[0] for a, b in zip(ranges, ranges[1:]))


def test_gb18030_takes_the_2022_edition_code_points():
    two_byte = {
        seq: cp for seq, cp in ICONV_REMAPPED["GB18030"] if seq <= 0xFFFF
    }
    moved = [
        cp
        for cp in two_byte.values()
        if 0xFE10 <= cp <= 0xFE19 or 0x9FB4 <= cp <= 0x9FBB
    ]
    assert len(moved) == 18
    assert two_byte[0xA6D9] == 0xFE10


def test_euc_kr_takes_the_2002_circled_hangul_ieung_u():
    assert (0xA2E8, 0x327E) in ICONV_REMAPPED["EUC-KR"]
