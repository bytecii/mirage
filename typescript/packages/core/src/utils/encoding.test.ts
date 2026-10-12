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

import { describe, expect, it } from 'vitest'
import { bomOf, decoderFor, encodingFor } from './encoding.ts'

const KELVIN = String.fromCharCode(0x212a)

describe('encodingFor', () => {
  it.each([
    ['latin1', 'windows-1252'],
    [' UTF-8 ', 'UTF-8'],
    ['\tutf-16\n', 'UTF-16LE'],
    ['SJIS', 'Shift_JIS'],
    ['x-user-defined', 'x-user-defined'],
  ])('reads %j as the standard does', (label, name) => {
    expect(encodingFor(label)).toBe(name)
  })

  // The replacement encoding's labels name none, as ripgrep looks them up
  // (`rg -E iso-2022-kr` is an unknown encoding), and only ASCII case folds:
  // the Kelvin sign lowercases to k.
  it.each(['utf16le', 'replacement', 'iso-2022-kr', '', `${KELVIN}oi8-r`, 'constructor'])(
    'names no encoding for %j',
    (label) => {
      expect(encodingFor(label)).toBeNull()
    },
  )
})

describe('bomOf', () => {
  it('names the mark a stream starts with', () => {
    expect(bomOf(new Uint8Array([0xef, 0xbb, 0xbf, 0x78]))?.[1]).toBe('UTF-8')
    expect(bomOf(new Uint8Array([0xff, 0xfe, 0x68]))?.[1]).toBe('UTF-16LE')
    expect(bomOf(new Uint8Array([0xfe, 0xff]))?.[1]).toBe('UTF-16BE')
    expect(bomOf(new Uint8Array([0xef, 0xbb]))).toBeNull()
  })
})

describe('decoderFor', () => {
  // Python's cp1252 leaves 0x81 unmapped and Node's TextDecoder reads
  // windows-1252 as latin-1; the standard's table maps both bytes.
  it('reads a single-byte encoding from the standard table', () => {
    expect(decoderFor('windows-1252')(new Uint8Array([0x80, 0x81, 0xe9]), true)).toBe(
      String.fromCharCode(0x20ac, 0x81, 0xe9),
    )
    expect(decoderFor('ISO-8859-16')(new Uint8Array([0xa1]), true)).toBe(String.fromCharCode(0x104))
    expect(decoderFor('x-user-defined')(new Uint8Array([0x61, 0x80, 0xff]), true)).toBe(
      String.fromCharCode(0x61, 0xf780, 0xf7ff),
    )
  })

  it('streams a multibyte encoding across chunks', () => {
    const wide = decoderFor('UTF-16LE')
    expect(wide(new Uint8Array([0x68, 0x00, 0x69]), false)).toBe('h')
    expect(wide(new Uint8Array([0x00]), false)).toBe('i')
    expect(wide(new Uint8Array([0x7a]), true)).toBe(String.fromCharCode(0xfffd))
    const sjis = decoderFor('Shift_JIS')
    expect(sjis(new Uint8Array([0x93]), false) + sjis(new Uint8Array([0xfa]), true)).toBe('日')
  })
})
