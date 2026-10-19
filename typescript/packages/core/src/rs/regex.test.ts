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
import { RegexError } from './errors.ts'
import { LineRegex, PosixRegex, posixEscape } from './regex.ts'

function texts(regex: PosixRegex, subject: string): (string | null)[] {
  const found = regex.search(subject)
  expect(found).not.toBeNull()
  return (found ?? []).map((span) => (span === null ? null : subject.slice(span[0], span[1])))
}

describe('PosixRegex', () => {
  it.each([
    ['(a|ab)(bc|c)', 'abc', ['abc', 'a', 'bc']],
    ['(ab|a)(bc|c)', 'abc', ['abc', 'ab', 'c']],
    ['(a|ab)*', 'abab', ['abab', 'ab']],
    ['(a*)(ab)*(b*)', 'aabab', ['aabab', 'a', 'ab', '']],
    ['(a*)+', 'aa', ['aa', 'aa']],
    ['(a?)*', 'aa', ['aa', 'a']],
    ['((a)|b)*', 'ab', ['ab', 'b', 'a']],
  ])('places the groups of %s on %s as glibc does', (pattern, subject, want) => {
    expect(texts(new PosixRegex(pattern, true, 'sed'), subject)).toEqual(want)
  })

  it('counts offsets in characters of the view', () => {
    expect(new PosixRegex('é.', false, 'posix', false, true).search('aéb')).toEqual([[1, 3]])
    expect(new PosixRegex('😀.', false, 'posix', false, true).search('a😀b')).toEqual([[1, 4]])
    expect(new PosixRegex('\\(.\\)').search('\xc3\xa9')).toEqual([
      [0, 1],
      [0, 1],
    ])
  })

  it('passes over an empty match where one ended in a global walk', () => {
    const found = new PosixRegex('a*', false, 'sed').all('baaac')
    expect(found.map((spans) => spans[0])).toEqual([
      [0, 0],
      [1, 4],
      [5, 5],
    ])
  })

  it.each([
    ['a**', false, 'sed'],
    ['*a', true, 'sed'],
    ['\\{1\\}', false, 'sed'],
    ['*a', true, 'posix'],
  ] as const)('refuses %s by its dialect', (pattern, extended, dialect) => {
    expect(() => new PosixRegex(pattern, extended, dialect)).toThrow(
      new RegexError('Invalid preceding regular expression'),
    )
  })

  it("takes in regcomp's basic syntax what sed refuses", () => {
    expect(new PosixRegex('a**').search('aa')).toEqual([[0, 2]])
    expect(new PosixRegex('[z-a]x').search('x')).toBeNull()
    expect(() => new PosixRegex('[z-a]', false, 'sed')).toThrow('Invalid range end')
  })

  it('reads the newlines a match consumes at its anchors', () => {
    expect(new PosixRegex('a.^b', true, 'sed').search('a\nb')).toEqual([[0, 3]])
    expect(new PosixRegex('^b', false, 'sed').search('a\nb')).toBeNull()
    expect(new PosixRegex('b$.', true, 'sed').search('b\nc')).toEqual([[0, 2]])
    expect(new PosixRegex('(b)$.', true, 'sed').search('b\nc')).toBeNull()
    expect(new PosixRegex('^b', false, 'sed', false, false, true).search('a\nb')).toEqual([[2, 3]])
  })

  it('skips NUL at a dot for regcomp only', () => {
    expect(new PosixRegex('a.b').search('a\0b')).toBeNull()
    expect(new PosixRegex('a[^x]b').search('a\0b')).toEqual([[0, 3]])
    expect(new PosixRegex('a.b', false, 'sed').search('a\0b')).toEqual([[0, 3]])
  })

  it('reads classes and case by Unicode under UTF-8', () => {
    expect(new PosixRegex('[[:alpha:]]', false, 'posix', false, true).search('-é')).toEqual([
      [1, 2],
    ])
    expect(new PosixRegex('é', false, 'posix', true, true).search('É')).not.toBeNull()
    expect(new PosixRegex('[[:alpha:]]').search('\xc3\xa9')).toBeNull()
  })

  it('never finds a raw byte inside a character', () => {
    const regex = new PosixRegex('\udca9', false, 'posix', false, true)
    expect(regex.search('é')).toBeNull()
    expect(regex.search('a\udca9')).toEqual([[1, 2]])
  })

  it('wraps the match in word edges', () => {
    const regex = new PosixRegex('ab|abc', true, 'posix', false, false, false, true)
    expect(regex.search('abcd abc')).toEqual([[5, 8]])
  })

  it('escapes a literal to match only itself', () => {
    const text = 'a.b*c[d]^$\\(e)'
    expect(new PosixRegex(posixEscape(text), true).search('x' + text)).toEqual([
      [1, 1 + text.length],
    ])
  })
})

describe('LineRegex', () => {
  it('selects and extends lines as grep does', () => {
    const regex = new LineRegex(['ab|abcd', 'x'], 'extended', false, false, true)
    expect(regex.matches('abcd y')).toBe(true)
    expect(regex.matches('abcde')).toBe(false)
    expect(regex.extents('abcd x')).toEqual([
      [0, 4],
      [5, 6],
    ])
    expect(regex.needles).toEqual(['ab', 'abcd', 'x'])
  })

  it("carries grep's warnings and refusals", () => {
    expect(new LineRegex(['*a'], 'extended').warnings).toEqual(['* at start of expression'])
    expect(() => new LineRegex(['\\(a'], 'basic')).toThrow('Unmatched ( or \\(')
  })

  it('drops the needles Unicode folding could miss', () => {
    expect(new LineRegex(['kelvin'], 'fixed', true, true).needles).toBeNull()
    expect(new LineRegex(['KELVIN'], 'fixed', true).needles).toEqual(['kelvin'])
  })
})
