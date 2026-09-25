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

import zlib
from collections.abc import AsyncIterator, Iterator

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


GZIP_TRAILING = "decompression OK, trailing garbage ignored"
GZIP_CHUNK_SIZE = 65536


class GzipDecoder:
    """Incremental member decoder with bounded decompressed chunks."""

    def __init__(self) -> None:
        self._decoder = zlib.decompressobj(31)
        self._between = True
        self._seen = False
        self._prefix = b""
        self._padding = False

    def feed(self, data: bytes) -> Iterator[bytes]:
        """Decode one input chunk without collecting its expansion.

        Args:
            data (bytes): The next compressed chunk.
        """
        while data:
            if self._between:
                data = self._prefix + data
                self._prefix = b""
                if self._seen and (self._padding or data[0] == 0):
                    self._padding = True
                    if any(data):
                        raise GzipDataError(GZIP_TRAILING, False, 2)
                    return
                if len(data) < 2:
                    self._prefix = data
                    return
                if not data.startswith(GZIP_MAGIC):
                    raise GzipDataError(
                        GZIP_TRAILING if self._seen else GZIP_NOT_GZIP, False,
                        2 if self._seen else 1)
                self._decoder = zlib.decompressobj(31)
                self._between = False
            try:
                out = self._decoder.decompress(data, GZIP_CHUNK_SIZE)
            except zlib.error as exc:
                raise GzipDataError(GZIP_CORRUPT, True) from exc
            decoder = self._decoder
            data = (decoder.unused_data
                    if decoder.eof else decoder.unconsumed_tail)
            if out:
                yield out
            if self._decoder.eof:
                self._seen = True
                self._between = True

    def finish(self) -> None:
        """Reject an absent header or an unfinished member at EOF.

        GNU gzip 1.13 also treats exactly one trailing nonzero byte as
        fatal EOF, even when it cannot start a member. Two junk bytes
        instead trigger the nonfatal trailing-garbage warning in feed.
        """
        if not self._seen or not self._between or self._prefix:
            raise GzipDataError(GZIP_EOF, True)


async def gunzip_stream(source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Decode concatenated members, yielding before reading more input.

    Args:
        source (AsyncIterator[bytes]): Compressed input chunks.
    """
    decoder = GzipDecoder()
    async for chunk in source:
        for out in decoder.feed(chunk):
            yield out
    decoder.finish()


def gunzip_checked(data: bytes) -> bytes:
    """Materialize a checked archive for consumers that need all its bytes.

    Args:
        data (bytes): Compressed input, with no trailing garbage.
    """
    decoder = GzipDecoder()
    parts = list(decoder.feed(data))
    decoder.finish()
    return b"".join(parts)
