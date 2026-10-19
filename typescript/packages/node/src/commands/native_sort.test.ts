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

describe.each(NATIVE_BACKENDS)('native sort (%s backend)', (kind) => {
  it.each([
    {
      name: 'sort default matches native',
      input: 'cherry\napple\nbanana\n',
      command: 'sort /data/f.txt',
      nativeCommand: 'sort f.txt',
    },
    {
      name: 'sort -r reverse matches native',
      input: 'a\nb\nc\n',
      command: 'sort -r /data/f.txt',
      nativeCommand: 'sort -r f.txt',
    },
    {
      name: 'sort -n numeric matches native',
      input: '10\n2\n1\n20\n',
      command: 'sort -n /data/f.txt',
      nativeCommand: 'sort -n f.txt',
    },
    {
      name: 'sort -u unique matches native',
      input: 'a\nb\na\nc\nb\n',
      command: 'sort -u /data/f.txt',
      nativeCommand: 'sort -u f.txt',
    },
    {
      name: 'sort -nr matches native',
      input: '10\n2\n1\n20\n',
      command: 'sort -nr /data/f.txt',
      nativeCommand: 'sort -nr f.txt',
    },
    {
      name: 'sort -t -k -n matches native',
      input: 'b,3\na,1\nc,2\n',
      command: 'sort -t , -k 2 -n /data/f.txt',
      nativeCommand: 'sort -t , -k 2 -n f.txt',
    },
    {
      name: 'sort -h human numeric matches native',
      input: '10K\n1M\n5G\n100\n2K\n',
      command: 'sort -h /data/f.txt',
      nativeCommand: 'sort -h f.txt',
    },
    {
      name: 'sort -hr matches native',
      input: '10K\n1M\n5G\n100\n2K\n',
      command: 'sort -hr /data/f.txt',
      nativeCommand: 'sort -hr f.txt',
    },
    {
      name: 'sort -V version matches native',
      input: 'v1.10\nv1.2\nv1.1\nv2.0\n',
      command: 'sort -V /data/f.txt',
      nativeCommand: 'sort -V f.txt',
    },
    {
      name: 'sort -Vr matches native',
      input: 'v1.10\nv1.2\nv1.1\nv2.0\n',
      command: 'sort -Vr /data/f.txt',
      nativeCommand: 'sort -Vr f.txt',
    },
    {
      name: 'sort -s stable matches native',
      input: 'b 2\na 1\nc 1\na 2\n',
      command: "sort -s -k 2 -t ' ' /data/f.txt",
      nativeCommand: "sort -s -k 2 -t ' ' f.txt",
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

  it.each([
    {
      name: 'sort stdin matches native',
      input: 'cherry\napple\nbanana\n',
      command: 'sort',
      nativeCommand: 'sort',
    },
    {
      name: 'sort -h stdin matches native',
      input: '1G\n500M\n2T\n100K\n',
      command: 'sort -h',
      nativeCommand: 'sort -h',
    },
    {
      name: 'sort -V stdin matches native',
      input: 'lib-2.1\nlib-1.10\nlib-1.2\nlib-3.0\n',
      command: 'sort -V',
      nativeCommand: 'sort -V',
    },
    {
      name: 'sort -s stdin matches native',
      input: 'b 2\na 1\nc 1\na 2\n',
      command: "sort -s -k 2 -t ' '",
      nativeCommand: "sort -s -k 2 -t ' '",
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

  it('sort -f fold case includes all items', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('B\na\nC\nb\n'))
      const result = await env.mirage('sort -f /data/f.txt')
      expect(result).toContain('a')
      expect(result).toContain('B')
    } finally {
      await env.cleanup()
    }
  })
})
