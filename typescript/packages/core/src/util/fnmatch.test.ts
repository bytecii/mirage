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
import { fnmatch, fnmatchCase } from './fnmatch.ts'

function legacyFnmatch(name: string, pattern: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '.')
    .replace(/\*/g, '.*')
  return new RegExp(`^${re}$`).test(name)
}

const NAMES = [
  '',
  'a',
  'a.txt',
  'A.TXT',
  'a.txt.bak',
  '.hidden',
  'a/b',
  'file?',
  '[abc]',
  'a{2}',
  'x+y',
]
const PATTERNS = ['*', '*.txt', 'a?txt*', '?', '', 'a.txt', '[abc]', 'a{2}', 'x+y', '*.*', 'a*b']

describe('fnmatch matches the prior per-file copies', () => {
  it('equals the legacy regex-replace implementation on a sample grid', () => {
    for (const name of NAMES)
      for (const pattern of PATTERNS)
        expect(fnmatch(name, pattern)).toBe(legacyFnmatch(name, pattern))
  })

  it('translates * and ? and anchors the match', () => {
    expect(fnmatch('a.txt', '*.txt')).toBe(true)
    expect(fnmatch('a.txt.bak', '*.txt')).toBe(false)
    expect(fnmatch('ab', 'a?')).toBe(true)
    expect(fnmatch('ab', '?')).toBe(false)
    expect(fnmatch('', '*')).toBe(true)
  })

  it('is case-sensitive and treats regex metachars literally', () => {
    expect(fnmatch('A.TXT', '*.txt')).toBe(false)
    expect(fnmatch('axtxt', 'a.txt')).toBe(false)
    expect(fnmatch('x+y', 'x+y')).toBe(true)
    expect(fnmatch('a{2}', 'a{2}')).toBe(true)
    expect(fnmatch('[abc]', '[abc]')).toBe(true)
    expect(fnmatch('b', '[abc]')).toBe(false)
  })
})

describe('fnmatchCase supports [...] character classes', () => {
  it('matches single characters from a class', () => {
    expect(fnmatchCase('b', '[abc]')).toBe(true)
    expect(fnmatchCase('d', '[abc]')).toBe(false)
    expect(fnmatchCase('file2', 'file[0-9]')).toBe(true)
    expect(fnmatchCase('fileX', 'file[0-9]')).toBe(false)
  })

  it('treats an unterminated [ as a literal', () => {
    expect(fnmatchCase('[ab', '[ab')).toBe(true)
    expect(fnmatchCase('a', '[ab')).toBe(false)
  })

  it('keeps * and ? semantics and stays case-sensitive', () => {
    expect(fnmatchCase('a.txt', '*.txt')).toBe(true)
    expect(fnmatchCase('A.TXT', '*.txt')).toBe(false)
    expect(fnmatchCase('ab', 'a?')).toBe(true)
    expect(fnmatchCase('x+y', 'x+y')).toBe(true)
    expect(fnmatchCase('a{2}', 'a{2}')).toBe(true)
  })
})
