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

import { seedVar } from '../../../workspace/session/state.ts'
import { setAttr } from '../../../workspace/session/state.ts'
import { VarAttr } from '../../../shell/variable.ts'
import { varsFromEnv } from '../../../workspace/session/session.ts'
import { describe } from 'vitest'
import { expect } from 'vitest'
import { it } from 'vitest'
import { byteChar } from '../../../shell/bytes.ts'
import { Session } from '../../session/session.ts'
import { handleEcho } from './index.ts'
import { handlePrintf } from './index.ts'
import { decode } from '../../fixtures/builtin_fixture.ts'

describe('handleEcho', () => {
  it('joins args with space and appends newline', () => {
    const [out] = handleEcho(['hi', 'there'])
    expect(decode(out as Uint8Array)).toBe('hi there\n')
  })

  it('-n suppresses trailing newline', () => {
    const [out] = handleEcho(['-n', 'hi'])
    expect(decode(out as Uint8Array)).toBe('hi')
  })

  it('-e interprets backslash escapes', () => {
    const [out] = handleEcho(['-e', 'hello\\nworld'])
    expect(decode(out as Uint8Array)).toBe('hello\nworld\n')
  })

  it('-e \\t becomes tab', () => {
    const [out] = handleEcho(['-e', 'a\\tb'])
    expect(decode(out as Uint8Array)).toBe('a\tb\n')
  })

  it('-e unknown escape passes through literally', () => {
    const [out] = handleEcho(['-e', '\\z'])
    expect(decode(out as Uint8Array)).toBe('\\z\n')
  })

  it('-e \\c stops output at that point', () => {
    const [out] = handleEcho(['-e', 'hi\\cgone'])
    expect(decode(out as Uint8Array)).toBe('hi\n')
  })

  it('-e reads \\xHH and \\0NNN as bytes', () => {
    const bytes = (args: string[]): number[] => [...(handleEcho(args)[0] as Uint8Array)]
    expect(bytes(['-ne', '\\xff'])).toEqual([0xff])
    expect(bytes(['-ne', '\\0377'])).toEqual([0xff])
    expect(bytes(['-ne', '\\xc3\\xa9'])).toEqual([0xc3, 0xa9])
  })
})

describe('handlePrintf', () => {
  const run = async (args: string[]): Promise<[string, number]> => {
    const [out, io] = await handlePrintf(args, new Session({ sessionId: 'test' }))
    return [decode(out as Uint8Array), io.exitCode]
  }
  const stdout = async (args: string[]): Promise<string> => {
    const [text, code] = await run(args)
    expect(code).toBe(0)
    return text
  }

  // Expectations verified byte-for-byte against GNU bash's builtin printf.
  const CASES: [string[], string, number][] = [
    [['%s\n', 'c', 'a', 'b'], 'c\na\nb\n', 0],
    [['%d\n', '1', '2', '3'], '1\n2\n3\n', 0],
    [['(%s,%s)', 'a', 'b', 'c'], '(a,b)(c,)', 0],
    [['hello\n', 'a', 'b', 'c'], 'hello\n', 0],
    [['%s=%d;', 'foo', '1', 'bar'], 'foo=1;bar=0;', 0],
    [['a%%b\n'], 'a%b\n', 0],
    [['[%s][%s]\n', 'x'], '[x][]\n', 0],
    [['[%d][%d]\n', '5'], '[5][0]\n', 0],
    [['[%-5s]', 'hi'], '[hi   ]', 0],
    [['[%5s]', 'hi'], '[   hi]', 0],
    [['[%.3s]', 'abcdef'], '[abc]', 0],
    [['[%05d]', '42'], '[00042]', 0],
    [['[%-05d]', '42'], '[42   ]', 0],
    [['[%.0d]', '0'], '[]', 0],
    [['[%+d]', '5'], '[+5]', 0],
    [['[% d]', '-5'], '[-5]', 0],
    [['[%o][%u][%x][%X]\n', '64', '64', '255', '255'], '[100][64][ff][FF]\n', 0],
    [['%x\n', '-1'], 'ffffffffffffffff\n', 0],
    [['%X\n', '-1'], 'FFFFFFFFFFFFFFFF\n', 0],
    [['%o\n', '-1'], '1777777777777777777777\n', 0],
    [['%u\n', '-1'], '18446744073709551615\n', 0],
    [['%#x\n', '255'], '0xff\n', 0],
    [['%#X\n', '255'], '0XFF\n', 0],
    [['%#o\n', '64'], '0100\n', 0],
    [['%#x\n', '0'], '0\n', 0],
    [['%#o\n', '0'], '0\n', 0],
    [['%08x\n', '255'], '000000ff\n', 0],
    [['%d\n', '0x1f'], '31\n', 0],
    [['%d\n', '010'], '8\n', 0],
    [['%d\n', '"A'], '65\n', 0],
    [['%d\n', "'Z"], '90\n', 0],
    [['[%c]\n', 'abc'], '[a]\n', 0],
    [['[%c%c]\n', 'xy', 'z'], '[xz]\n', 0],
    [['[%b]\n', 'a\\tb'], '[a\tb]\n', 0],
    [['[%b]\n', 'x\\101y'], '[xAy]\n', 0],
    [['[%b]', 'ab\\ccd'], '[ab', 0],
    [['[%*d]\n', '5', '42'], '[   42]\n', 0],
    [['[%.*f]\n', '2', '3.14159'], '[3.14]\n', 0],
    [['[%*.*f]\n', '10', '2', '3.14159'], '[      3.14]\n', 0],
    [['[%*d]\n', '-5', '42'], '[42   ]\n', 0],
    [['%.2f\n', '3.14159'], '3.14\n', 0],
    [['%.0f\n', '0.5'], '0\n', 0],
    [['%.0f\n', '1.5'], '2\n', 0],
    [['%.0f\n', '2.5'], '2\n', 0],
    [['%010.2f\n', '3.14'], '0000003.14\n', 0],
    [['%#.0f\n', '3'], '3.\n', 0],
    [['%g|%g|%g|%g\n', '1.', '.5', '1e2', '+1.25e-2'], '1|0.5|100|0.0125\n', 0],
    [['%g', `${'0'.repeat(20_000)}x`], '0', 1],
    [['%e\n', '0'], '0.000000e+00\n', 0],
    [['%.2e\n', '12345.678'], '1.23e+04\n', 0],
    [['%g\n', '100000'], '100000\n', 0],
    [['%g\n', '1000000'], '1e+06\n', 0],
    [['%g\n', '0.0001'], '0.0001\n', 0],
    [['%g\n', '0.00001'], '1e-05\n', 0],
    [['%#g\n', '1.5'], '1.50000\n', 0],
    [['x\\ty\\n'], 'x\ty\n', 0],
    [['\\101\\n'], 'A\n', 0],
    [['%d\n', 'abc'], '0\n', 1],
    [['%d\n', '3.9'], '3\n', 1],
  ]

  it.each(CASES)('printf %j → %j', async (args, expected, code) => {
    expect(await run(args)).toEqual([expected, code])
  })

  it('reads \\xHH and \\NNN as bytes, \\u as a code point', async () => {
    // bash writes \xff as the byte 0xFF, which is not valid UTF-8 at all,
    // rather than as the code point U+00FF.
    const bytes = async (args: string[]): Promise<number[]> => [
      ...(((await handlePrintf(args, new Session({ sessionId: 'test' })))[0] ?? []) as Uint8Array),
    ]
    expect(await bytes(['\\xff'])).toEqual([0xff])
    expect(await bytes(['\\377'])).toEqual([0xff])
    expect(await bytes(['\\xc3\\xa9'])).toEqual([0xc3, 0xa9])
    expect(await bytes(['\\x41\\x42'])).toEqual([0x41, 0x42])
    expect(await bytes(['%b', '\\xff'])).toEqual([0xff])
    expect(await bytes(['\\u00e9'])).toEqual([0xc3, 0xa9])
  })

  it('quotes a raw byte as octal', async () => {
    expect(await stdout(['%q\n', byteChar(0xff)])).toBe("$'\\377'\n")
  })

  it('empty args → empty output', async () => {
    const [out] = await handlePrintf([], new Session({ sessionId: 'test' }))
    expect((out as Uint8Array).byteLength).toBe(0)
  })

  it('reuses the format for excess args, drops excess when no conversion', async () => {
    expect(await stdout(['%s\n', 'c', 'a', 'b'])).toBe('c\na\nb\n')
    expect(await stdout(['hello\n', 'a', 'b', 'c'])).toBe('hello\n')
  })

  it('inf and nan', async () => {
    expect(await stdout(['%f|%e|%g\n', 'inf', 'inf', 'inf'])).toBe('inf|inf|inf\n')
    expect(await stdout(['%f\n', '-inf'])).toBe('-inf\n')
    expect(await stdout(['%F|%G\n', 'nan', 'nan'])).toBe('NAN|NAN\n')
  })

  it('%c of empty string is a NUL byte', async () => {
    expect(await stdout(['[%c]', ''])).toBe('[\x00]')
  })

  it('\\u / \\U unicode escapes', async () => {
    expect(await stdout(['\\u00e9\n'])).toBe('é\n')
    expect(await stdout(['\\U0001F600'])).toBe('😀')
  })

  it('%q shell-quoting', async () => {
    expect(await stdout(['%q\n', 'a b'])).toBe('a\\ b\n')
    expect(await stdout(['%q\n', ''])).toBe("''\n")
    expect(await stdout(['%q\n', "it's"])).toBe("it\\'s\n")
    expect(await stdout(['%q\n', 'ümlaut'])).toBe("$'\\303\\274mlaut'\n")
    expect(await stdout(['%q\n', 'tab\ttab'])).toBe("$'tab\\ttab'\n")
  })

  it('%a at IEEE double precision (differs from bash long double)', async () => {
    expect(await stdout(['%a\n', '1.0'])).toBe('0x1p+0\n')
    expect(await stdout(['%a\n', '0.5'])).toBe('0x1p-1\n')
    expect(await stdout(['%a\n', '3.14'])).toBe('0x1.91eb851eb851fp+1\n')
    expect(await stdout(['%A\n', '255.5'])).toBe('0X1.FFP+7\n')
  })

  it('-v assigns to a variable and prints nothing', async () => {
    const s = new Session({ sessionId: 'test' })
    const [out, io] = await handlePrintf(['-v', 'V', 'x=%d', '42'], s)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(s.env.V).toBe('x=42')
  })

  it('-v targets an array element', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'arr[2]', 'hi'], s)
    expect(io.exitCode).toBe(0)
    // Indices 0 and 1 are holes, not empty elements.
    expect(s.arrays.arr).toEqual([null, null, 'hi'])
  })

  it('-v with an invalid name errors before the format runs', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', '1bad', 'x'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe("printf: `1bad': not a valid identifier\n")
    const [, io2] = await handlePrintf(['-v', '1bad', '%d', 'nope'], s)
    expect(io2.exitCode).toBe(2)
    expect(decode(io2.stderr as Uint8Array)).toBe("printf: `1bad': not a valid identifier\n")
  })

  it('-v rejects an empty subscript but allows a blank one', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'a[]', 'x'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe("printf: `a[]': not a valid identifier\n")
    expect('a' in s.arrays).toBe(false)
    // `a[ ]` is a valid arithmetic 0, not an empty subscript.
    const [, io2] = await handlePrintf(['-v', 'a[ ]', 'x'], s)
    expect(io2.exitCode).toBe(0)
    expect(s.arrays.a).toEqual(['x'])
  })

  it('-v refuses a readonly scalar and a readonly array element', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ R: 'orig' }) })
    setAttr(s, 'R', VarAttr.Readonly)
    const [, io] = await handlePrintf(['-v', 'R', 'new'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: R: readonly variable\n')
    expect(s.env.R).toBe('orig')
    seedVar(s, 'A', ['x', 'y'])
    setAttr(s, 'A', VarAttr.Readonly)
    const [, io2] = await handlePrintf(['-v', 'A[0]', '%d', 'nope'], s)
    expect(io2.exitCode).toBe(1)
    expect(decode(io2.stderr as Uint8Array)).toBe(
      'printf: nope: invalid number\nbash: A: readonly variable\n',
    )
    expect(s.arrays.A).toEqual(['x', 'y'])
  })

  it('-v on a bare name keeps the other elements of an existing array', async () => {
    const s = new Session({ sessionId: 'test' })
    seedVar(s, 'B', ['p', 'q', 'r'])
    const [, io] = await handlePrintf(['-v', 'B', 'Q'], s)
    expect(io.exitCode).toBe(0)
    expect(s.arrays.B).toEqual(['Q', 'q', 'r'])
    expect('B' in s.env).toBe(false)
  })

  it('-v with an out-of-range subscript keeps the scalar', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ V: 'orig' }) })
    const [, io] = await handlePrintf(['-v', 'V[-2]', 'hi'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: V[-2]: bad array subscript\n')
    expect(s.env.V).toBe('orig')
    expect('V' in s.arrays).toBe(false)
  })

  it('-v with a negative subscript wraps over the scalar', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ W: 'orig' }) })
    const [, io] = await handlePrintf(['-v', 'W[-1]', 'hi'], s)
    expect(io.exitCode).toBe(0)
    expect(s.arrays.W).toEqual(['hi'])
    expect('W' in s.env).toBe(false)
  })

  it('-v on __proto__ makes a real variable instead of touching the prototype', async () => {
    const s = new Session({ sessionId: 'test' })
    expect((await handlePrintf(['-v', '__proto__[0]', 'hi'], s))[1].exitCode).toBe(0)
    expect(Object.hasOwn(s.arrays, '__proto__')).toBe(true)
    // Session records are null-prototype (ownRecord), so there is no
    // prototype to corrupt in the first place.
    expect(Object.getPrototypeOf(s.arrays)).toBe(null)
    expect(({} as Record<string, unknown>)[0]).toBeUndefined()
  })

  it('-v keeps exit 1 on a bad number but still assigns', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'V', '%d', 'notanum'], s)
    expect(io.exitCode).toBe(1)
    expect(s.env.V).toBe('0')
  })
})

describe('handleEcho GNU option rules', () => {
  it('trailing -n prints literally', () => {
    const [out] = handleEcho(['hi', '-n'])
    expect(decode(out as Uint8Array)).toBe('hi -n\n')
  })

  it('unknown char makes the word literal', () => {
    const [out] = handleEcho(['-nq', 'hi'])
    expect(decode(out as Uint8Array)).toBe('-nq hi\n')
  })

  it('cluster -ne applies both', () => {
    const [out] = handleEcho(['-ne', 'a\\tb'])
    expect(decode(out as Uint8Array)).toBe('a\tb')
  })

  it('last of -e/-E wins', () => {
    const [a] = handleEcho(['-eE', 'a\\tb'])
    expect(decode(a as Uint8Array)).toBe('a\\tb\n')
    const [b] = handleEcho(['-Ee', 'a\\tb'])
    expect(decode(b as Uint8Array)).toBe('a\tb\n')
  })
})
