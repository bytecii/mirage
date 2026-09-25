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

from mirage.io.types import materialize
from mirage.utils.compress import (GZIP_CHUNK_SIZE, gunzip_checked,
                                   gunzip_stream)
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


@pytest.mark.asyncio
@pytest.mark.parametrize("width", [1, 7, 65536])
async def test_member_headers_trailers_and_padding_across_chunks(width):
    data = HELLO + HELLO + b"\0\0"

    async def source():
        for offset in range(0, len(data), width):
            yield data[offset:offset + width]

    assert await materialize(gunzip_stream(source())) == b"hello\nhello\n"


@pytest.mark.asyncio
async def test_expansion_yields_bounded_chunks_before_reading_more_input():
    archive = gzip.compress(b"x" * (GZIP_CHUNK_SIZE * 20))
    reads = []

    async def source():
        reads.append(1)
        yield archive
        reads.append(2)
        yield HELLO

    decoded = gunzip_stream(source())
    assert await anext(decoded) == b"x" * GZIP_CHUNK_SIZE
    assert reads == [1]
    await decoded.aclose()
    assert reads == [1]


@pytest.mark.asyncio
async def test_trailing_warning_follows_valid_output():

    async def source():
        yield HELLO + b"junk"

    decoded = gunzip_stream(source())
    assert await anext(decoded) == b"hello\n"
    with pytest.raises(GzipDataError) as exc:
        await anext(decoded)
    assert exc.value.exit_code == 2
    assert not exc.value.fatal


def test_large_member_preserves_buffered_output():
    data = b"x" * (GZIP_CHUNK_SIZE * 20 + 13)
    assert gunzip_checked(gzip.compress(data)) == data
