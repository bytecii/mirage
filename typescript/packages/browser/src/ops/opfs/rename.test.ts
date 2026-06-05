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
import { exists } from '../../core/opfs/exists.ts'
import { read } from '../../core/opfs/read.ts'
import { writeBytes } from '../../core/opfs/write.ts'
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { renameOp } from './rename.ts'

describe('renameOp (opfs)', () => {
  it('moves a file', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/a'), new TextEncoder().encode('hi'))
    await renameOp.fn(accessor, spec('/a'), [spec('/b')], {})
    expect(await exists(accessor, spec('/a'))).toBe(false)
    expect(new TextDecoder().decode(await read(accessor, spec('/b')))).toBe('hi')
  })

  it('throws when dst is not a PathSpec', () => {
    const accessor = makeMockAccessor()
    expect(() => renameOp.fn(accessor, spec('/a'), ['plain'], {})).toThrow(/PathSpec destination/)
  })
})
