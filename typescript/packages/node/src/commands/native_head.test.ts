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

const ENC = new TextEncoder()

describe.each(NATIVE_BACKENDS)('native head (%s backend)', (kind) => {
  it('head default matches native', async () => {
    const env = makeEnv(kind)
    try {
      let lines = ''
      for (let i = 1; i < 20; i++) lines += `line${String(i)}\n`
      env.createFile('f.txt', ENC.encode(lines))
      const m = await env.mirage('head /data/f.txt')
      const n = await env.native('head f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it.each([
    {
      name: 'head -n 5 matches native',
      input: 'a\nb\nc\nd\ne\nf\n',
      command: 'head -n 5 /data/f.txt',
      nativeCommand: 'head -n 5 f.txt',
    },
    {
      name: 'head -c 5 matches native',
      input: 'hello world\n',
      command: 'head -c 5 /data/f.txt',
      nativeCommand: 'head -c 5 f.txt',
    },
    {
      name: 'head on file with fewer lines matches native',
      input: 'a\nb\n',
      command: 'head /data/f.txt',
      nativeCommand: 'head f.txt',
    },
  ])('$name', async ({ input, command, nativeCommand }) => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode(input))
      const m = await env.mirage(command)
      const n = await env.native(nativeCommand)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('head -n 3 stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\nd\ne\nf\n')
      const m = await env.mirage('head -n 3', data)
      const n = await env.native('head -n 3', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
