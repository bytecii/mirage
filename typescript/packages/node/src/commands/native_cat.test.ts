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

describe.each(NATIVE_BACKENDS)('native cat (%s backend)', (kind) => {
  it.each([
    {
      name: 'cat basic file matches native /bin/sh cat',
      input: 'hello world\n',
      command: 'cat /data/f.txt',
      nativeCommand: 'cat f.txt',
    },
    {
      name: 'cat -n matches native',
      input: 'hello\nworld\n',
      command: 'cat -n /data/f.txt',
      nativeCommand: 'cat -n f.txt',
    },
    {
      name: 'cat multiline matches native',
      input: 'line1\nline2\nline3\n',
      command: 'cat /data/f.txt',
      nativeCommand: 'cat f.txt',
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

  it('cat stdin passthrough matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('from stdin\n')
      const m = await env.mirage('cat', data)
      const n = await env.native('cat', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
