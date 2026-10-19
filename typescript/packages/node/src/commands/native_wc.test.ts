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

function firstField(s: string): string {
  return s.trim().split(/\s+/)[0] ?? ''
}

describe.each(NATIVE_BACKENDS)('native wc (%s backend)', (kind) => {
  it.each([
    {
      name: 'wc -l matches native',
      input: 'a\nb\nc\n',
      command: 'wc -l /data/f.txt',
      nativeCommand: 'wc -l f.txt',
    },
    {
      name: 'wc -w matches native',
      input: 'hello world\nfoo\n',
      command: 'wc -w /data/f.txt',
      nativeCommand: 'wc -w f.txt',
    },
    {
      name: 'wc -c matches native',
      input: 'hello\n',
      command: 'wc -c /data/f.txt',
      nativeCommand: 'wc -c f.txt',
    },
    {
      name: 'wc -L matches native',
      input: 'short\na much longer line\nmed\n',
      command: 'wc -L /data/f.txt',
      nativeCommand: 'wc -L f.txt',
    },
    {
      name: 'wc -L empty matches native',
      input: '',
      command: 'wc -L /data/f.txt',
      nativeCommand: 'wc -L f.txt',
    },
    {
      name: 'wc -L single line matches native',
      input: 'hello world\n',
      command: 'wc -L /data/f.txt',
      nativeCommand: 'wc -L f.txt',
    },
    {
      name: 'wc -m matches native',
      input: 'hello\n',
      command: 'wc -m /data/f.txt',
      nativeCommand: 'wc -m f.txt',
    },
  ])('$name', async ({ input, command, nativeCommand }) => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode(input))
      const m = firstField(await env.mirage(command))
      const n = firstField(await env.native(nativeCommand))
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc -l stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = (await env.mirage('wc -l', data)).trim()
      const n = (await env.native('wc -l', data)).trim()
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc default counts match native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\nfoo bar\n'))
      const mParts = (await env.mirage('wc /data/f.txt')).trim().split(/\s+/)
      const nParts = (await env.native('wc f.txt')).trim().split(/\s+/)
      expect(mParts.slice(0, 3)).toEqual(nParts.slice(0, 3))
    } finally {
      await env.cleanup()
    }
  })

  it('wc -L stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('short\na much longer line\nmed\n')
      const m = (await env.mirage('wc -L', data)).trim()
      const n = (await env.native('wc -L', data)).trim()
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
