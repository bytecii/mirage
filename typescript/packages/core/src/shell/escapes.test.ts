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

import { encodeText } from './bytes.ts'
import { decodeAnsiC } from './escapes.ts'

// Direct port of tests/shell/test_escapes.py. Expectations pinned
// against bash 5.2.37 in docker (debian:stable-slim, LC_ALL=C.UTF-8).

describe('decodeAnsiC', () => {
  it.each([
    ['a\\nb', 'a\nb'],
    ['\\a\\b\\f\\r\\t\\v', '\x07\b\f\r\t\v'],
    ['\\e\\E', '\x1b\x1b'],
    ['\\\\', '\\'],
    ['\\\'\\"\\?', '\'"?'],
    ['plain', 'plain'],
    ['', ''],
  ])('decodes simple escapes: %s', (content, expected) => {
    expect(decodeAnsiC(content)).toBe(expected)
  })

  it.each([
    ['\\x41', 'A'],
    ['\\x9', '\t'],
    ['\\x413', 'A3'],
    ['\\101', 'A'],
    ['\\1013', 'A3'],
    ['\\0101', '\b1'],
    ['\\u41', 'A'],
    ['中', '中'],
    ['\\U0001F600', '\u{1F600}'],
  ])('decodes numeric escapes: %s', (content, expected) => {
    expect(decodeAnsiC(content)).toBe(expected)
  })

  it.each([
    ['\\cA', '\x01'],
    ['\\cz', '\x1a'],
    ['\\c[', '\x1b'],
    ['\\c?', '\x7f'],
  ])('decodes control escapes: %s', (content, expected) => {
    expect(decodeAnsiC(content)).toBe(expected)
  })

  it('consumes an escaped backslash as one control operand', () => {
    // \c\\ is ctrl-backslash and both characters belong to the operand;
    // \c\n is ctrl-backslash followed by a literal n (bash 5.2).
    expect(decodeAnsiC('\\c\\\\')).toBe('\x1c')
    expect(decodeAnsiC('\\c\\n')).toBe('\x1cn')
  })

  it.each([['\\q'], ['\\x'], ['\\u'], ['\\U'], ['\\c'], ['\\8']])(
    'keeps unknown or incomplete escapes verbatim: %s',
    (content) => {
      expect(decodeAnsiC(content)).toBe(content)
    },
  )

  it('keeps a trailing backslash verbatim', () => {
    expect(decodeAnsiC('a\\')).toBe('a\\')
  })

  it('does not treat backslash-newline as a continuation', () => {
    expect(decodeAnsiC('\\\nx')).toBe('\\\nx')
  })

  it.each([
    ['a\\0b'],
    ['a\\x00b'],
    ['a\\u0000b'],
    ['a\\c@b'],
    ['a\\400b'],
  ])('truncates the segment at NUL: %s', (content) => {
    expect(decodeAnsiC(content)).toBe('a')
  })

  it('carries high bytes through the surrogate escape', () => {
    expect(encodeText(decodeAnsiC('\\xff'))).toEqual(new Uint8Array([0xff]))
    expect(encodeText(decodeAnsiC('\\777'))).toEqual(new Uint8Array([0xff]))
    // Three hex byte escapes reassemble into one UTF-8 character.
    expect(encodeText(decodeAnsiC('\\xe4\\xb8\\xad'))).toEqual(new TextEncoder().encode('中'))
  })

  it('keeps a value past Unicode verbatim', () => {
    expect(decodeAnsiC('\\UFFFFFFFF')).toBe('\\UFFFFFFFF')
  })
})
