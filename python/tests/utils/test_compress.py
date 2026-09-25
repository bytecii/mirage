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
import gzip

import pytest

from mirage.utils.compress import gunzip_checked
from mirage.utils.errors import GzipDataError

HELLO = gzip.compress(b"hello\n", mtime=0)


def test_every_member_decompresses():
    assert gunzip_checked(HELLO + HELLO) == b"hello\nhello\n"


@pytest.mark.parametrize("data,reason,fatal", [
    (b"", "unexpected end of file", True),
    (b"x", "unexpected end of file", True),
    (b"hello\n", "not in gzip format", False),
    (HELLO[:10], "unexpected end of file", True),
    (b"\x1f\x8b\x08\x00garbage-here", "invalid compressed data--format "
     "violated", True),
])
def test_refusals_carry_gzips_reason_and_severity(data, reason, fatal):
    # gzip 1.13: no header is reported and skipped, while a short,
    # truncated or corrupt input ends the run.
    with pytest.raises(GzipDataError) as exc:
        gunzip_checked(data)
    assert (str(exc.value), exc.value.fatal) == (reason, fatal)
