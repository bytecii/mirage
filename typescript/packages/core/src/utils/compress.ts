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

/**
 * Decompress one gzip input, judged the way `gzip -d` judges it.
 *
 * Every member decompresses, so concatenated files read whole. Bytes after the
 * last member are refused as corrupt, where gzip keeps the output and warns;
 * Node refuses zero padding there too, which gzip and Python drop, so there the
 * twins differ. A runtime that gives no error code reads a truncated stream as
 * corrupt. Mirrors Python's gunzip_checked.
 */
export async function gunzipChecked(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.byteLength < 2) throw new GzipDataError(GZIP_EOF, true)
  if (!hasGzipMagic(bytes)) throw new GzipDataError(GZIP_NOT_GZIP, false)
  try {
    return await gunzip(bytes)
  } catch (err) {
    const truncated = (err as { code?: unknown }).code === 'Z_BUF_ERROR'
    throw new GzipDataError(truncated ? GZIP_EOF : GZIP_CORRUPT, true, { cause: err })
  }
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
