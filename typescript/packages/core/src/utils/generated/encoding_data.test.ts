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
import { ENCODING_LABELS, SINGLE_BYTE } from './encoding_data.ts'

// Twin of python/tests/utils/generated/test_encoding_data.py.
describe('the generated encoding tables', () => {
  it('name, for every label, an encoding one decoder reads', () => {
    const names = new Set(Object.values(ENCODING_LABELS))
    expect(names.has('replacement')).toBe(false)
    for (const name of names) {
      if (Object.hasOwn(SINGLE_BYTE, name)) continue
      expect(() => new TextDecoder(name)).not.toThrow()
    }
    for (const label of Object.keys(ENCODING_LABELS)) {
      expect(label).toBe(label.trim().toLowerCase())
    }
  })

  it('map the high half of every single-byte encoding', () => {
    for (const points of Object.values(SINGLE_BYTE)) expect(points).toHaveLength(128)
    expect(SINGLE_BYTE['windows-1252']?.[0]).toBe(0x20ac)
    expect(SINGLE_BYTE['x-user-defined']?.[127]).toBe(0xf7ff)
  })
})
