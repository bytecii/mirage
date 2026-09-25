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
// Mirrors python/tests/utils/test_compress.py.

import { describe, expect, it } from 'vitest'
import { materialize } from '../io/types.ts'
import { yieldBytes } from '../io/stream.ts'
import { GZIP_CHUNK_SIZE, gunzipStream, gunzipChecked, gzip } from './compress.ts'
import { GzipDataError } from './errors.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('gunzipChecked', () => {
  it('decompresses every member', async () => {
    const hello = await gzip(ENC.encode('hello\n'))
    const both = new Uint8Array([...hello, ...hello])
    expect(DEC.decode(await gunzipChecked(both))).toBe('hello\nhello\n')
  })

  // gzip 1.13: no header is reported and skipped, while a short, truncated
  // or corrupt input ends the run.
  it.each([
    ['empty', new Uint8Array(0), 'unexpected end of file', true],
    ['one byte', ENC.encode('x'), 'unexpected end of file', true],
    ['plain', ENC.encode('hello\n'), 'not in gzip format', false],
    [
      'corrupt',
      new Uint8Array([0x1f, 0x8b, 8, 0, ...ENC.encode('garbage-here')]),
      'invalid compressed data--format violated',
      true,
    ],
  ] as const)('refuses %s with gzip reason and severity', async (_name, data, reason, fatal) => {
    const call = gunzipChecked(data)
    await expect(call).rejects.toBeInstanceOf(GzipDataError)
    await expect(call).rejects.toMatchObject({ message: reason, fatal })
  })

  it('calls a truncated archive an unexpected end', async () => {
    const hello = await gzip(ENC.encode('hello\n'))
    await expect(gunzipChecked(hello.subarray(0, 10))).rejects.toMatchObject({
      message: 'unexpected end of file',
      fatal: true,
    })
  })
})

describe('gunzipStream', () => {
  it.each([1, 7, 65536])(
    'handles member boundaries and padding at chunk width %i',
    async (width) => {
      const hello = await gzip(ENC.encode('hello\n'))
      const data = new Uint8Array([...hello, ...hello, 0, 0])
      async function* source(): AsyncIterable<Uint8Array> {
        for (let offset = 0; offset < data.length; offset += width)
          yield* yieldBytes(data.subarray(offset, offset + width))
      }
      expect(DEC.decode(await materialize(gunzipStream(source())))).toBe('hello\nhello\n')
    },
  )

  it('yields bounded expansion before reading more input', async () => {
    const archive = await gzip(ENC.encode('x'.repeat(GZIP_CHUNK_SIZE * 20)))
    const reads: number[] = []
    async function* source(): AsyncIterable<Uint8Array> {
      reads.push(1)
      yield* yieldBytes(archive)
      reads.push(2)
      yield* yieldBytes(archive)
    }
    const decoded = gunzipStream(source())[Symbol.asyncIterator]()
    expect((await decoded.next()).value).toEqual(ENC.encode('x'.repeat(GZIP_CHUNK_SIZE)))
    expect(reads).toEqual([1])
    await decoded.return?.()
    expect(reads).toEqual([1])
  })

  it('reports trailing garbage after yielding valid output', async () => {
    const archive = await gzip(ENC.encode('hello\n'))
    const decoded = gunzipStream(yieldBytes(new Uint8Array([...archive, ...ENC.encode('junk')])))[
      Symbol.asyncIterator
    ]()
    expect((await decoded.next()).value).toEqual(ENC.encode('hello\n'))
    await expect(decoded.next()).rejects.toMatchObject({ exitCode: 2, fatal: false })
  })
})

it('preserves buffered output in a large member', async () => {
  const text = 'x'.repeat(GZIP_CHUNK_SIZE * 20 + 13)
  expect(DEC.decode(await gunzipChecked(await gzip(ENC.encode(text))))).toBe(text)
})
