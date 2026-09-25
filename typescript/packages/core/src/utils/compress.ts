// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import {
  ZStream,
  Z_NO_FLUSH,
  Z_OK,
  Z_STREAM_END,
  Z_BUF_ERROR,
  zlibInflate,
  zlibInflateInit2,
  zlibInflateEnd,
} from 'pako'
import { yieldBytes } from '../io/stream.ts'
import { concat } from '../io/cachable_iterator.ts'
import { GzipDataError } from './errors.ts'

// gzip 1.13's words for the inputs `gzip -d` refuses.
const GZIP_NOT_GZIP = 'not in gzip format'
const GZIP_EOF = 'unexpected end of file'
const GZIP_CORRUPT = 'invalid compressed data--format violated'

async function runThrough(
  bytes: Uint8Array,
  transform: GenericTransformStream,
): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart])
  const piped = blob.stream().pipeThrough(transform)
  const buf = await new Response(piped).arrayBuffer()
  return new Uint8Array(buf)
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new CompressionStream('gzip'))
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new DecompressionStream('gzip'))
}

/** Whether bytes open with the gzip magic. */
export function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

const GZIP_TRAILING = 'decompression OK, trailing garbage ignored'
export const GZIP_CHUNK_SIZE = 65536

class GzipDecoder {
  private decoder: ZStream | null = null
  private seen = false
  private prefix: Uint8Array = new Uint8Array()
  private padding = false;

  *feed(input: Uint8Array): Generator<Uint8Array> {
    let data = input
    while (data.byteLength > 0) {
      if (this.decoder === null) {
        if (this.prefix.byteLength > 0) data = concat([this.prefix, data])
        this.prefix = new Uint8Array()
        if (this.seen && (this.padding || data[0] === 0)) {
          this.padding = true
          if (data.some((byte) => byte !== 0))
            throw new GzipDataError(GZIP_TRAILING, false, undefined, 2)
          return
        }
        if (data.byteLength < 2) {
          this.prefix = data
          return
        }
        if (!hasGzipMagic(data)) {
          throw new GzipDataError(
            this.seen ? GZIP_TRAILING : GZIP_NOT_GZIP,
            false,
            undefined,
            this.seen ? 2 : 1,
          )
        }
        this.decoder = new ZStream()
        if (zlibInflateInit2(this.decoder, 31) !== Z_OK)
          throw new Error('gzip decoder initialization failed')
      }
      const decoder = this.decoder
      decoder.input = data
      decoder.next_in = 0
      decoder.avail_in = data.byteLength
      do {
        decoder.output = new Uint8Array(GZIP_CHUNK_SIZE)
        decoder.next_out = 0
        decoder.avail_out = GZIP_CHUNK_SIZE
        const status = zlibInflate(decoder, Z_NO_FLUSH)
        if (decoder.next_out > 0) yield decoder.output.subarray(0, decoder.next_out)
        if (status === Z_STREAM_END) {
          this.seen = true
          this.close()
          break
        }
        if (status !== Z_OK && status !== Z_BUF_ERROR) throw new GzipDataError(GZIP_CORRUPT, true)
      } while (decoder.avail_in > 0 || decoder.avail_out === 0)
      data = data.subarray(decoder.next_in)
    }
  }

  // GNU gzip 1.13 treats a single trailing nonzero byte as fatal EOF;
  // the trailing-garbage warning requires at least two bytes.
  finish(): void {
    if (!this.seen || this.decoder !== null || this.prefix.byteLength > 0)
      throw new GzipDataError(GZIP_EOF, true)
  }

  close(): void {
    if (this.decoder !== null) zlibInflateEnd(this.decoder)
    this.decoder = null
  }
}

/** Decode gzip members with bounded output chunks and consumer backpressure. */
export async function* gunzipStream(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const decoder = new GzipDecoder()
  try {
    for await (const chunk of source) yield* decoder.feed(chunk)
    decoder.finish()
  } finally {
    decoder.close()
  }
}

/** Materialize checked gzip for consumers that need the whole decoded file. */
export async function gunzipChecked(bytes: Uint8Array): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of gunzipStream(yieldBytes(bytes))) parts.push(part)
  return concat(parts)
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new CompressionStream('deflate-raw'))
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new DecompressionStream('deflate-raw'))
}

// `compress` is optional because a codec may be decompress-only: every
// permissively licensed bzip2 implementation decompresses only, so mirage
// reads a .tar.bz2 and refuses to create one.
export interface CompressionCodec {
  compress?(bytes: Uint8Array): Promise<Uint8Array>
  decompress(bytes: Uint8Array): Promise<Uint8Array>
}

const codecs = new Map<string, CompressionCodec>()

// gzip ships in every runtime via CompressionStream; heavier codecs (bzip2,
// xz) are registered by the runtime package that bundles a dependency for
// them. Browser core leaves them unregistered, so tar -j/-J report
// "not supported" there.
export function registerCompressionCodec(name: string, codec: CompressionCodec): void {
  codecs.set(name, codec)
}

export function getCompressionCodec(name: string): CompressionCodec | undefined {
  return codecs.get(name)
}
