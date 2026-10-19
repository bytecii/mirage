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

describe.each(NATIVE_BACKENDS)('native grep (%s backend)', (kind) => {
  it.each([
    {
      name: 'grep basic matches native',
      input: 'hello world\nfoo bar\nhello again\n',
      command: 'grep hello /data/f.txt',
      nativeCommand: 'grep hello f.txt',
    },
    {
      name: 'grep -i (case insensitive) matches native',
      input: 'Hello\nworld\nHELLO\n',
      command: 'grep -i hello /data/f.txt',
      nativeCommand: 'grep -i hello f.txt',
    },
    {
      name: 'grep -v (invert match) matches native',
      input: 'hello\nworld\nfoo\n',
      command: 'grep -v hello /data/f.txt',
      nativeCommand: 'grep -v hello f.txt',
    },
    {
      name: 'grep -n (line numbers) matches native',
      input: 'hello\nworld\nhello\n',
      command: 'grep -n hello /data/f.txt',
      nativeCommand: 'grep -n hello f.txt',
    },
    {
      name: 'grep -c (count) matches native',
      input: 'hello\nworld\nhello\n',
      command: 'grep -c hello /data/f.txt',
      nativeCommand: 'grep -c hello f.txt',
    },
    {
      name: 'grep -w (word) matches native',
      input: 'hello\nhelloworld\nhello there\n',
      command: 'grep -w hello /data/f.txt',
      nativeCommand: 'grep -w hello f.txt',
    },
    {
      name: 'grep -F (fixed string) matches native',
      input: 'a.b\na*b\naXb\n',
      command: "grep -F 'a.b' /data/f.txt",
      nativeCommand: "grep -F 'a.b' f.txt",
    },
    {
      name: 'grep -o (only matching) matches native',
      input: 'hello world\nfoo hello\n',
      command: 'grep -o hello /data/f.txt',
      nativeCommand: 'grep -o hello f.txt',
    },
    {
      name: 'grep -m (max count) matches native',
      input: 'a\na\na\na\n',
      command: 'grep -m 2 a /data/f.txt',
      nativeCommand: 'grep -m 2 a f.txt',
    },
    {
      name: 'grep -iv (combined) matches native',
      input: 'Hello\nworld\nHELLO\nfoo\n',
      command: 'grep -iv hello /data/f.txt',
      nativeCommand: 'grep -iv hello f.txt',
    },
    {
      name: 'grep -nw (combined) matches native',
      input: 'hello\nhelloworld\nhello there\n',
      command: 'grep -nw hello /data/f.txt',
      nativeCommand: 'grep -nw hello f.txt',
    },
    {
      name: 'grep -Fc (combined) matches native',
      input: 'a.b\na.b\naXb\n',
      command: "grep -Fc 'a.b' /data/f.txt",
      nativeCommand: "grep -Fc 'a.b' f.txt",
    },
    {
      name: 'grep no match matches native',
      input: 'hello\nworld\n',
      command: 'grep zzz /data/f.txt',
      nativeCommand: 'grep zzz f.txt',
    },
    {
      name: 'grep -A (after context) matches native',
      input: 'a\nb\nc\nd\ne\n',
      command: 'grep -A 1 c /data/f.txt',
      nativeCommand: 'grep -A 1 c f.txt',
    },
    {
      name: 'grep -B (before context) matches native',
      input: 'a\nb\nc\nd\ne\n',
      command: 'grep -B 1 c /data/f.txt',
      nativeCommand: 'grep -B 1 c f.txt',
    },
    {
      name: 'grep -C (context) matches native',
      input: 'a\nb\nc\nd\ne\n',
      command: 'grep -C 1 c /data/f.txt',
      nativeCommand: 'grep -C 1 c f.txt',
    },
    {
      name: 'grep -A multiple matches matches native',
      input: 'x\na\nb\nc\na\nd\ne\n',
      command: 'grep -A 1 a /data/f.txt',
      nativeCommand: 'grep -A 1 a f.txt',
    },
    {
      name: 'grep -B multiple matches matches native',
      input: 'x\ny\na\nb\nc\na\n',
      command: 'grep -B 1 a /data/f.txt',
      nativeCommand: 'grep -B 1 a f.txt',
    },
    {
      name: 'grep -C multiple matches matches native',
      input: 'w\nx\na\ny\nz\na\nb\n',
      command: 'grep -C 1 a /data/f.txt',
      nativeCommand: 'grep -C 1 a f.txt',
    },
    {
      name: 'grep -A overlapping matches native',
      input: 'a\nb\na\nc\nd\n',
      command: 'grep -A 2 a /data/f.txt',
      nativeCommand: 'grep -A 2 a f.txt',
    },
    {
      name: 'grep -n -A combined matches native',
      input: 'a\nb\nc\nd\ne\n',
      command: 'grep -n -A 1 c /data/f.txt',
      nativeCommand: 'grep -n -A 1 c f.txt',
    },
    {
      name: 'grep -C -i combined matches native',
      input: 'aaa\nbbb\nAAA\nccc\n',
      command: 'grep -C 1 -i aaa /data/f.txt',
      nativeCommand: 'grep -C 1 -i aaa f.txt',
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
      name: 'grep stdin matches native',
      input: 'hello world\nfoo bar\nhello again\n',
      command: 'grep hello',
      nativeCommand: 'grep hello',
    },
    {
      name: 'grep stdin -i matches native',
      input: 'Hello\nworld\nHELLO\n',
      command: 'grep -i hello',
      nativeCommand: 'grep -i hello',
    },
    {
      name: 'grep stdin -c matches native',
      input: 'a\nb\na\n',
      command: 'grep -c a',
      nativeCommand: 'grep -c a',
    },
    {
      name: 'grep -e stdin matches native',
      input: 'hello\nworld\nfoo\n',
      command: 'grep -e hello',
      nativeCommand: 'grep -e hello',
    },
    {
      name: 'grep -A stdin matches native',
      input: 'a\nb\nc\nd\ne\n',
      command: 'grep -A 1 c',
      nativeCommand: 'grep -A 1 c',
    },
    {
      name: 'grep -C stdin matches native',
      input: 'a\nb\nc\nd\ne\n',
      command: 'grep -C 1 c',
      nativeCommand: 'grep -C 1 c',
    },
    {
      name: 'grep -E extended regex matches native',
      input: 'foo\nbar\nbaz\n',
      command: "grep -E 'foo|bar'",
      nativeCommand: "grep -E 'foo|bar'",
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

  it('grep -r lists file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      const result = await env.mirage('grep -r -l hello /data')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -l lists file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -r -l hello /data')
      expect(result).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -q quiet produces no output', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -q hello /data/f.txt')
      expect(result).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -R recursive returns matching line', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -R hello /data')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -H with filename returns match', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -H hello /data/f.txt')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -r -h suppresses filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -r -h hello /data')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })
})
