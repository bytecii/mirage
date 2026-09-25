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
import zlib
from collections.abc import AsyncIterator

from mirage.utils.errors import GzipDataError

GZIP_MAGIC = b"\x1f\x8b"
# gzip 1.13's words for the inputs ``gzip -d`` refuses.
GZIP_NOT_GZIP = "not in gzip format"
GZIP_EOF = "unexpected end of file"
GZIP_CORRUPT = "invalid compressed data--format violated"


async def gzip_compress_stream(
    source: AsyncIterator[bytes],
    level: int,
) -> AsyncIterator[bytes]:
    """Gzip a byte stream chunk by chunk.

    Args:
        source (AsyncIterator[bytes]): plain input chunks.
        level (int): zlib compression level.

    Yields:
        bytes: gzip member bytes, trailer included.
    """
    compressor = zlib.compressobj(level, zlib.DEFLATED, zlib.MAX_WBITS | 16)
    async for chunk in source:
        compressed = compressor.compress(chunk)
        if compressed:
            yield compressed
    tail = compressor.flush()
    if tail:
        yield tail


def gunzip_checked(data: bytes) -> bytes:
    """Decompress one gzip input, judged the way ``gzip -d`` judges it.

    Every member decompresses, so concatenated files read whole. Bytes
    after the last member are refused as corrupt, where gzip keeps the
    output and warns; zero padding is dropped as gzip drops it, which
    Node's DecompressionStream refuses, so there the twins differ.

    Args:
        data (bytes): the whole input.

    Raises:
        GzipDataError: the input is too short to hold a header, holds no
            gzip header, or is truncated or corrupt.
    """
    if len(data) < len(GZIP_MAGIC):
        raise GzipDataError(GZIP_EOF, fatal=True)
    if not data.startswith(GZIP_MAGIC):
        raise GzipDataError(GZIP_NOT_GZIP, fatal=False)
    try:
        return gzip.decompress(data)
    except EOFError as exc:
        raise GzipDataError(GZIP_EOF, fatal=True) from exc
    except (OSError, zlib.error) as exc:
        raise GzipDataError(GZIP_CORRUPT, fatal=True) from exc
