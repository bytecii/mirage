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

describe.each(NATIVE_BACKENDS)('native uniq (%s backend)', (kind) => {
  it.each([
    {
      name: 'uniq default matches native',
      input: 'a\na\nb\nc\nc\n',
      command: 'uniq /data/f.txt',
      nativeCommand: 'uniq f.txt',
    },
    {
      name: 'uniq -d matches native',
      input: 'a\na\nb\nc\nc\n',
      command: 'uniq -d /data/f.txt',
      nativeCommand: 'uniq -d f.txt',
    },
    {
      name: 'uniq -u matches native',
      input: 'a\na\nb\nc\nc\n',
      command: 'uniq -u /data/f.txt',
      nativeCommand: 'uniq -u f.txt',
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

  it('uniq -c matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\na\nb\nc\nc\nc\n'))
      const mOut = await env.mirage('uniq -c /data/f.txt')
      const nOut = await env.native('uniq -c f.txt')
      const mLines = mOut.trim().split('\n')
      const nLines = nOut.trim().split('\n')
      const mPairs = mLines
        .filter((x) => x.trim())
        .map((x) => {
          const parts = x.split(/\s+/).filter((p) => p.length > 0)
          return [parts[0], parts[1]]
        })
      const nPairs = nLines
        .filter((x) => x.trim())
        .map((x) => {
          const parts = x.split(/\s+/).filter((p) => p.length > 0)
          return [parts[0], parts[1]]
        })
      expect(mPairs).toEqual(nPairs)
    } finally {
      await env.cleanup()
    }
  })

  it.each([
    {
      name: 'uniq stdin matches native',
      input: 'a\na\nb\n',
      command: 'uniq',
      nativeCommand: 'uniq',
    },
    {
      name: 'uniq -i matches native',
      input: 'Hello\nhello\nWorld\n',
      command: 'uniq -i',
      nativeCommand: 'uniq -i',
    },
    {
      name: 'uniq -f matches native',
      input: 'a 1\nb 1\nc 2\n',
      command: 'uniq -f 1',
      nativeCommand: 'uniq -f 1',
    },
    {
      name: 'uniq -s matches native',
      input: 'xxhello\nyyhello\nzzworld\n',
      command: 'uniq -s 2',
      nativeCommand: 'uniq -s 2',
    },
  ])('$name', async ({ input, command, nativeCommand }) => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode(input)
      const m = await env.mirage(command, data)
      const n = await env.native(nativeCommand, data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('uniq -w produces expected output', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('abc\nabd\nxyz\n')
      const m = await env.mirage('uniq -w 2', data)
      expect(m).toBe('abc\nxyz\n')
    } finally {
      await env.cleanup()
    }
  })
})
