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

import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeEnv, NATIVE_BACKENDS } from '../../tests/commands/native_fixture.ts'

const ENC = new TextEncoder()

describe.each(NATIVE_BACKENDS)('native zgrep flags (%s backend)', (kind) => {
  it('zgrep -w whole word', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nhelloworld\nhello there\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -w hello /data/f.txt.gz')
      expect(result).not.toContain('helloworld')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it.each([
    {
      name: 'zgrep -i case insensitive',
      input: 'Hello\nworld\n',
      command: 'zgrep -i hello /data/f.txt.gz',
      expected: 'Hello',
    },
    {
      name: 'zgrep -c count',
      input: 'hello\nworld\nhello\n',
      command: 'zgrep -c hello /data/f.txt.gz',
      expected: '2',
    },
    {
      name: 'zgrep -l list filenames',
      input: 'hello\nworld\n',
      command: 'zgrep -l hello /data/f.txt.gz',
      expected: 'f.txt',
    },
    {
      name: 'zgrep -F fixed string',
      input: 'a.b\na*b\n',
      command: "zgrep -F 'a.b' /data/f.txt.gz",
      expected: 'a.b',
    },
    {
      name: 'zgrep -H with filename',
      input: 'hello\n',
      command: 'zgrep -H hello /data/f.txt.gz',
      expected: 'f.txt',
    },
    {
      name: 'zgrep -h no filename',
      input: 'hello\n',
      command: 'zgrep -h hello /data/f.txt.gz',
      expected: 'hello',
    },
    {
      name: 'zgrep -E reads an extended expression',
      input: 'aab\na+b\n',
      command: "zgrep -E 'a+b' /data/f.txt.gz",
      expected: 'aab',
    },
    {
      name: 'zgrep backslash-plus is the basic operator',
      input: 'aab\na+b\n',
      command: "zgrep 'a\\+b' /data/f.txt.gz",
      expected: 'aab',
    },
  ])('$name', async ({ input, command, expected }) => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode(input))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage(command)
      expect(result).toContain(expected)
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -v invert match', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -v hello /data/f.txt.gz')
      expect(result).toContain('world')
      expect(result).not.toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -n line numbers', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -n hello /data/f.txt.gz')
      expect(result.includes('1:') || result.includes('1\t')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -e pattern from stdin', async () => {
    const env = makeEnv(kind)
    try {
      const compressed = new Uint8Array(gzipSync(Buffer.from('hello\nworld\n')))
      const result = await env.mirage('zgrep -e hello', compressed)
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -E extended regex', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('foo\nbar\nbaz\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep -E 'foo|bar' /data/f.txt.gz")
      expect(result).toContain('foo')
      expect(result).toContain('bar')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -o only matching', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -o hello /data/f.txt.gz')
      expect(result.trim()).toBe('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -m max count', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\na\na\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -m 1 a /data/f.txt.gz')
      const count = (result.trim().match(/a/g) ?? []).length
      expect(count).toBe(1)
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -q quiet', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -q hello /data/f.txt.gz')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  // zgrep is grep over decompressed bytes, so + is an ordinary character.
  it('zgrep reads a basic expression', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aab\na+b\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep 'a+b' /data/f.txt.gz")
      expect(result).toContain('a+b')
      expect(result).not.toContain('aab')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -G asks for the default dialect', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aab\na+b\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep -G 'a+b' /data/f.txt.gz")
      expect(result).toContain('a+b')
      expect(result).not.toContain('aab')
    } finally {
      await env.cleanup()
    }
  })
})
