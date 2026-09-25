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
import { gunzipChecked, gzip } from './compress.ts'
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
