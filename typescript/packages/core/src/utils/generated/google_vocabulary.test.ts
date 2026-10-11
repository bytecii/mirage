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
import { DOCS_WORDS, SHEETS_WORDS, SLIDES_WORDS } from './google_vocabulary.ts'

// Twin of python/tests/utils/generated/test_google_vocabulary.py.
describe('the generated Google vocabulary', () => {
  it('holds the names each rendering carries', () => {
    for (const word of ['paragraph', 'textrun', 'normal_text']) expect(DOCS_WORDS.has(word)).toBe(true)
    for (const word of ['formattedvalue', 'spreadsheetid']) expect(SHEETS_WORDS.has(word)).toBe(true)
    for (const word of ['pageelements', 'objectid']) expect(SLIDES_WORDS.has(word)).toBe(true)
  })

  it('is lowercase and leaves out the request types', () => {
    for (const words of [DOCS_WORDS, SHEETS_WORDS, SLIDES_WORDS]) {
      for (const word of words) expect(word).toBe(word.toLowerCase())
    }
    expect(DOCS_WORDS.has('inserttext')).toBe(false)
  })
})
