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
import { ICONV_EXCLUDED, ICONV_ONE_WAY, ICONV_REMAPPED } from './iconv_data.ts'

const CHARSETS = ['EUC-CN', 'EUC-JP', 'EUC-KR', 'GB18030', 'GBK', 'SJIS']

// Twin of python/tests/utils/generated/test_iconv_data.py.
describe('the generated iconv correction tables', () => {
  it('cover the same charsets', () => {
    for (const table of [ICONV_REMAPPED, ICONV_EXCLUDED, ICONV_ONE_WAY])
      expect(Object.keys(table).sort()).toEqual(CHARSETS)
  })

  it('list each sequence and code point once, in order', () => {
    for (const table of [ICONV_REMAPPED, ICONV_ONE_WAY]) {
      for (const pairs of Object.values(table)) {
        const keys = pairs.map(([key]) => key)
        expect(keys).toEqual([...new Set(keys)].sort((a, b) => a - b))
      }
    }
    for (const ranges of Object.values(ICONV_EXCLUDED)) {
      ranges.forEach(([first, last], i) => {
        expect(first).toBeLessThanOrEqual(last)
        const next = ranges[i + 1]
        if (next !== undefined) expect(last).toBeLessThan(next[0])
      })
    }
  })

  it('take the code points GB 18030-2022 moved', () => {
    const twoByte = new Map((ICONV_REMAPPED.GB18030 ?? []).filter(([seq]) => seq <= 0xffff))
    const moved = [...twoByte.values()].filter(
      (cp) => (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0x9fb4 && cp <= 0x9fbb),
    )
    expect(moved).toHaveLength(18)
    expect(twoByte.get(0xa6d9)).toBe(0xfe10)
  })

  it("take KS X 1001:2002's circled hangul ieung u", () => {
    expect(ICONV_REMAPPED['EUC-KR']).toContainEqual([0xa2e8, 0x327e])
  })
})
