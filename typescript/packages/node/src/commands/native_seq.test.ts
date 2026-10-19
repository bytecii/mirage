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
import { makeEnv, NATIVE_BACKENDS } from '../../tests/commands/native_fixture.ts'

describe.each(NATIVE_BACKENDS)('native seq (%s backend)', (kind) => {
  it.each([
    { name: 'seq 1 arg matches native', command: 'seq 4' },
    { name: 'seq 2 args matches native', command: 'seq 3 5' },
    { name: 'seq 3 args matches native', command: 'seq 1 2 7' },
    { name: 'seq -f format matches native', command: "seq -f '%.2f' 1 3" },
    { name: 'seq -w zero-pad matches native', command: 'seq -w 1 10' },
  ])('$name', async ({ command }) => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage(command)
      const n = await env.native(command)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('seq -s separator produces expected output', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('seq -s , 1 3')
      expect(result.trim()).toBe('1,2,3')
    } finally {
      await env.cleanup()
    }
  })
})
