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

describe.each(NATIVE_BACKENDS)('native sed (%s backend)', (kind) => {
  it.each([
    {
      name: 'sed substitute matches native',
      input: 'hello world\n',
      command: 'sed s/hello/bye/',
    },
    {
      name: 'sed global substitute matches native',
      input: 'foo boo\n',
      command: 'sed s/o/0/g',
    },
    {
      name: 'sed first-only substitute matches native',
      input: 'foo boo\n',
      command: 'sed s/o/0/',
    },
    {
      name: 'sed delete line by number matches native',
      input: 'a\nb\nc\n',
      command: 'sed 2d',
    },
    {
      name: 'sed delete by regex matches native',
      input: 'foo\nbar\nfoo2\n',
      command: 'sed /foo/d',
    },
    {
      name: 'sed -n suppress matches native',
      input: 'a\nb\nc\n',
      command: 'sed -n p',
    },
    {
      name: 'sed -n with address matches native',
      input: 'a\nb\nc\n',
      command: 'sed -n 2p',
    },
    {
      name: 'sed -n range matches native',
      input: 'a\nb\nc\nd\ne\n',
      command: 'sed -n 2,4p',
    },
    {
      name: 'sed -n regex address matches native',
      input: 'hello\nworld\nhello again\n',
      command: 'sed -n /hello/p',
    },
    {
      name: 'sed -E extended regex matches native',
      input: 'foo123bar\nhello\n',
      command: "sed -E 's/[0-9]+/NUM/g'",
    },
    {
      name: 'sed -E groups matches native',
      input: 'hello world\n',
      command: "sed -E 's/(hello) (world)/\\2 \\1/'",
    },
    {
      name: 'sed -nE combined matches native',
      input: 'abc123\ndef\nghi456\n',
      command: "sed -nE '/[0-9]+/p'",
    },
  ])('$name', async ({ input, command }) => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode(input)
      const m = await env.mirage(command, data)
      const n = await env.native(command, data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed on file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      const m = await env.mirage('sed s/hello/bye/ /data/f.txt')
      const n = await env.native('sed s/hello/bye/ f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -n on file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\ne\n'))
      const m = await env.mirage('sed -n 2,3p /data/f.txt')
      const n = await env.native('sed -n 2,3p f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it.each([
    {
      // Regression for #326: ^/$ must anchor per line, not at buffer ends.
      name: 'sed anchored substitution matches native',
      input: '#123\nls\n',
      command: "sed 's/^#[0-9]*$/#TS/'",
      expected: '#TS\nls\n',
    },
    {
      name: 'sed -E anchored substitution matches native',
      input: '#123\nls\n',
      command: "sed -E 's/^#[0-9]+$/#TS/'",
      expected: '#TS\nls\n',
    },
    {
      name: 'sed anchored address matches native',
      input: '12\nab\n34\n',
      command: "sed '/^[0-9]*$/d'",
      expected: 'ab\n',
    },
    {
      name: 'sed s/// numeric count replaces Nth match, matches native',
      input: 'oooo\n',
      command: "sed 's/o/O/2'",
      expected: 'oOoo\n',
    },
    {
      name: 'sed s///p prints substituted line, matches native',
      input: 'hi\nbye\n',
      command: "sed 's/hi/HI/p'",
      expected: 'HI\nHI\nbye\n',
    },
    {
      name: 'sed -n s///p prints only substituted lines, matches native',
      input: 'hi\nbye\n',
      command: "sed -n 's/hi/HI/p'",
      expected: 'HI\n',
    },
    {
      name: 'sed y/// transliterates, matches native',
      input: 'hello\n',
      command: "sed 'y/el/ip/'",
      expected: 'hippo\n',
    },
    {
      name: 'sed c changes an addressed line, matches native',
      input: 'a\nb\nc\n',
      command: "sed '2c\\\nX'",
      expected: 'a\nX\nc\n',
    },
    {
      name: 'sed c changes a line range once, matches native',
      input: 'a\nb\nc\nd\n',
      command: "sed '2,3c\\\nX'",
      expected: 'a\nX\nd\n',
    },
    {
      name: 'sed BRE group + backref matches native',
      input: 'foo\n',
      command: "sed 's/\\(foo\\)/[\\1]/'",
      expected: '[foo]\n',
    },
    {
      name: 'sed -r is an alias for -E, matches native',
      input: 'aaab\n',
      command: "sed -r 's/a+/X/'",
      expected: 'Xb\n',
    },
    {
      name: 'sed multiple -e expressions apply in sequence, matches native',
      input: 'a\n',
      command: "sed -e 's/a/b/' -e 's/b/c/'",
      expected: 'c\n',
    },
    {
      name: 'sed negated line address matches native',
      input: 'a\nb\nc\n',
      command: "sed '2!d'",
      expected: 'b\n',
    },
    {
      name: 'sed negated regex address matches native',
      input: 'a\nb\nc\n',
      command: "sed '/b/!d'",
      expected: 'b\n',
    },
    {
      name: 'sed preserves a missing final newline, matches native',
      input: 'foo',
      command: "sed 's/o/O/'",
      expected: 'fOo',
    },
    {
      name: 'sed escaped delimiter matches native',
      input: 'a/b\n',
      command: "sed 's/a\\/b/c/'",
      expected: 'c\n',
    },
  ])('$name', async ({ input, command, expected }) => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode(input)
      const m = await env.mirage(command, data)
      const n = await env.native(command, data)
      expect(m).toBe(n)
      expect(m).toBe(expected)
    } finally {
      await env.cleanup()
    }
  })

  it('sed anchored substitution on a file argument matches native', async () => {
    // The single-`s` fast-path (file args) must anchor per line too (#326).
    const env = makeEnv(kind)
    try {
      env.createFile('anchors.txt', ENC.encode('#123\nls\n#456\nfoo bar\n'))
      const m = await env.mirage("sed 's/^#[0-9]*$/#TS/' /data/anchors.txt")
      const n = await env.native("sed 's/^#[0-9]*$/#TS/' anchors.txt")
      expect(m).toBe(n)
      expect(m).toBe('#TS\nls\n#TS\nfoo bar\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed non-global sub on a file replaces first match per line', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('multi.txt', ENC.encode('oo\noo\noo\n'))
      const m = await env.mirage("sed 's/o/O/' /data/multi.txt")
      const n = await env.native("sed 's/o/O/' multi.txt")
      expect(m).toBe(n)
      expect(m).toBe('Oo\nOo\nOo\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -i anchored substitution on a file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('anchors_i.txt', ENC.encode('#123\nls\n#456\nfoo bar\n'))
      await env.mirage("sed -i 's/^#[0-9]*$/#TS/' /data/anchors_i.txt")
      const result = await env.mirage('cat /data/anchors_i.txt')
      expect(result).toBe('#TS\nls\n#TS\nfoo bar\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed BRE interval and bare + literal match native', async () => {
    const env = makeEnv(kind)
    try {
      const d1 = ENC.encode('aaa\n')
      expect(await env.mirage("sed 's/a\\{2\\}/X/'", d1)).toBe(
        await env.native("sed 's/a\\{2\\}/X/'", d1),
      )
      const d2 = ENC.encode('a+b\n')
      const m = await env.mirage("sed 's/a+/X/'", d2)
      expect(m).toBe(await env.native("sed 's/a+/X/'", d2))
      expect(m).toBe('Xb\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -E group/quantifier/alternation match native', async () => {
    const env = makeEnv(kind)
    try {
      const d1 = ENC.encode('foo\n')
      expect(await env.mirage("sed -E 's/(foo)/[\\1]/'", d1)).toBe(
        await env.native("sed -E 's/(foo)/[\\1]/'", d1),
      )
      const d2 = ENC.encode('aaab\n')
      expect(await env.mirage("sed -E 's/a+/X/'", d2)).toBe(
        await env.native("sed -E 's/a+/X/'", d2),
      )
      const d3 = ENC.encode('dog\n')
      const m = await env.mirage("sed -E 's/cat|dog/PET/'", d3)
      expect(m).toBe(await env.native("sed -E 's/cat|dog/PET/'", d3))
      expect(m).toBe('PET\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -e with a file argument matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('ef.txt', ENC.encode('hello world\n'))
      const m = await env.mirage('sed -e s/hello/bye/ /data/ef.txt')
      const n = await env.native('sed -e s/hello/bye/ ef.txt')
      expect(m).toBe(n)
      expect(m).toBe('bye world\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -i edits file in place', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      await env.mirage('sed -i s/hello/bye/ /data/f.txt')
      const result = await env.mirage('cat /data/f.txt')
      expect(result).toContain('bye')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -e applies expression', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world\n')
      const result = await env.mirage('sed -e s/hello/bye/', data)
      expect(result).toContain('bye')
    } finally {
      await env.cleanup()
    }
  })
})
