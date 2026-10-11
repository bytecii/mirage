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

from mirage.utils.encoding import DECODERS
from mirage.utils.generated.encoding_data import ENCODING_LABELS, SINGLE_BYTE


def test_every_label_names_an_encoding_one_decoder_reads():
    names = set(ENCODING_LABELS.values())
    assert names == set(SINGLE_BYTE) | set(DECODERS)
    assert not set(SINGLE_BYTE) & set(DECODERS)
    assert "replacement" not in names
    assert all(label == label.strip().lower() for label in ENCODING_LABELS)


def test_every_table_maps_the_high_half():
    assert all(len(points) == 128 for points in SINGLE_BYTE.values())
    assert SINGLE_BYTE["windows-1252"][0] == 0x20AC
    assert SINGLE_BYTE["x-user-defined"][-1] == 0xF7FF
