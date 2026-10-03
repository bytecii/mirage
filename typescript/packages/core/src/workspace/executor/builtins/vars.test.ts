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
import { materialize } from '../../../io/types.ts'
import { CallStack } from '../../../shell/call_stack.ts'
import { Session } from '../../session/session.ts'
import { handleExport } from './index.ts'
import { handleLocal } from './index.ts'
import { handleReadonly } from './index.ts'
import { handlePrintenv } from './index.ts'
import { handleReturn } from './index.ts'
import { handleUnset } from './index.ts'
import { ReturnSignal } from '../control.ts'
import { decode } from '../../fixtures/builtin_fixture.ts'

describe('handleExport / handleUnset / handlePrintenv', () => {
  it('export KEY=VAL sets session env', async () => {
    const s = new Session({ sessionId: 'test' })
    await handleExport(['FOO=bar', 'BAZ=qux'], s)
    expect(s.env.FOO).toBe('bar')
    expect(s.env.BAZ).toBe('qux')
  })

  it('export KEY (no =) marks it without giving it a value', async () => {
    // bash's third state: declared and exported but *unset*. GNU prints
    // `declare -x Y` with no `=`, and `env` does not carry it at all, so
    // the empty string this used to write was a divergence.
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ X: 'existing' }) })
    await handleExport(['X', 'Y'], s)
    expect(s.env.X).toBe('existing')
    expect(s.env.Y).toBeUndefined()
    expect(s.vars.Y?.attrs.has(VarAttr.Export)).toBe(true)
    expect(s.vars.Y?.value).toBeNull()
  })

  it('export -p prints declare -x lines', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ ZZZ: '1', AAA: 'a"b' }) })
    const [out, io] = await handleExport(['-p'], s)
    expect(io.exitCode).toBe(0)
    const text = decode(out as Uint8Array)
    expect(text).toContain('declare -x AAA="a\\"b"\n')
    expect(text).toContain('declare -x ZZZ="1"\n')
    expect(text.indexOf('AAA')).toBeLessThan(text.indexOf('ZZZ'))
  })

  it('bare export prints like -p', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport([], s)
    expect(io.exitCode).toBe(0)
    // $PWD is exported like any other variable, so bash lists it here too.
    expect(decode(out as Uint8Array)).toBe('declare -x FOO="bar"\ndeclare -x PWD="/"\n')
  })

  it('export -z is invalid option exit 2', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleExport(['-z'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toContain('invalid option')
    expect(decode(io.stderr as Uint8Array)).toContain('usage: export')
  })

  it('export -p with a name does not print', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ KEEP: '1' }) })
    const [out, io] = await handleExport(['-p', 'FOO=bar'], s)
    expect(io.exitCode).toBe(0)
    expect(out).toBeNull()
    expect(s.env.FOO).toBe('bar')
  })

  it('readonly -p prints scalars and arrays', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
    setAttr(s, 'VAL', VarAttr.Readonly)
    setAttr(s, 'ONLY', VarAttr.Readonly)
    seedVar(s, 'AR', ['a', 'b c'])
    setAttr(s, 'AR', VarAttr.Readonly)
    const [out, io] = await handleReadonly(['-p'], s)
    expect(io.exitCode).toBe(0)
    const text = decode(out as Uint8Array)
    expect(text).toContain('declare -ar AR=([0]="a" [1]="b c")\n')
    expect(text).toContain('declare -r ONLY\n')
    expect(text).toContain('declare -r VAL="x"\n')
  })

  it('readonly -z is invalid option exit 2', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleReadonly(['-z'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toContain('invalid option')
  })

  it('export -p quotes control characters like bash', async () => {
    const s = new Session({
      sessionId: 'test',
      vars: varsFromEnv({
        TAB: 'a\tb',
        ESC: 'a\x1bb',
        BEL: 'a\x07b',
        SOH: 'a\x01b',
        DEL: 'a\x7fb',
        UTF: 'café',
      }),
    })
    const [out, io] = await handleExport(['-p'], s)
    expect(io.exitCode).toBe(0)
    const text = decode(out as Uint8Array)
    // GNU bash uses $'...' for any control character, named escapes where it
    // has one and three-digit octal otherwise.
    expect(text).toContain("declare -x TAB=$'a\\tb'\n")
    expect(text).toContain("declare -x ESC=$'a\\Eb'\n")
    expect(text).toContain("declare -x BEL=$'a\\ab'\n")
    expect(text).toContain("declare -x SOH=$'a\\001b'\n")
    expect(text).toContain("declare -x DEL=$'a\\177b'\n")
    // Printable non-ASCII stays literal, as bash does in a UTF-8 locale.
    expect(text).toContain('declare -x UTF="café"\n')
  })

  it('export -p -- still prints', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport(['-p', '--'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('declare -x FOO="bar"\ndeclare -x PWD="/"\n')
  })

  it('export -f lists no variables', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport(['-f'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('')
  })

  it('export reports the first invalid option letter', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleExport(['-zq'], s)
    expect(decode(io.stderr as Uint8Array)).toContain('export: -z: invalid option')
    expect(decode(io.stderr as Uint8Array)).not.toContain('-q: invalid option')
  })

  it('readonly -a lists arrays only', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
    setAttr(s, 'VAL', VarAttr.Readonly)
    seedVar(s, 'AR', ['a'])
    setAttr(s, 'AR', VarAttr.Readonly)
    const [out, io] = await handleReadonly(['-a'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('declare -ar AR=([0]="a")\n')
  })

  it('readonly -f and -A list nothing', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
    setAttr(s, 'VAL', VarAttr.Readonly)
    for (const flag of ['-f', '-A']) {
      const [out, io] = await handleReadonly([flag], s)
      expect(io.exitCode).toBe(0)
      expect(decode(out as Uint8Array)).toBe('')
    }
  })

  it('unset removes keys', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ A: '1', B: '2' }) })
    await handleUnset(['A'], s)
    expect('A' in s.env).toBe(false)
    expect(s.env.B).toBe('2')
  })

  it('unset -f removes a function but not a same-named variable', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ fn: 'v' }) })
    s.functions.fn = []
    await handleUnset(['-f', 'fn'], s)
    expect('fn' in s.functions).toBe(false)
    expect(s.env.fn).toBe('v')
  })

  it('unset -v removes a variable but not a same-named function', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ fn: 'v' }) })
    s.functions.fn = []
    await handleUnset(['-v', 'fn'], s)
    expect('fn' in s.functions).toBe(true)
    expect('fn' in s.env).toBe(false)
  })

  it('unset bare prefers a variable, else the function', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ a: 'v' }) })
    s.functions.a = []
    await handleUnset(['a'], s)
    expect('a' in s.env).toBe(false)
    expect('a' in s.functions).toBe(true)
    s.functions.b = []
    await handleUnset(['b'], s)
    expect('b' in s.functions).toBe(false)
  })

  it('unset removes a whole array and a single element', async () => {
    const s = new Session({ sessionId: 'test' })
    seedVar(s, 'arr', ['x', 'y', 'z'])
    // An interior element leaves a hole so later indices keep their
    // positions; a trailing one drops off, as bash does.
    await handleUnset(['arr[1]'], s)
    expect(s.arrays.arr).toEqual(['x', null, 'z'])
    await handleUnset(['arr[2]'], s)
    expect(s.arrays.arr).toEqual(['x'])
    await handleUnset(['arr'], s)
    expect('arr' in s.arrays).toBe(false)
  })

  it('unset rejects an element of a readonly array', async () => {
    const s = new Session({ sessionId: 'test' })
    seedVar(s, 'arr', ['x', 'y'])
    setAttr(s, 'arr', VarAttr.Readonly)
    const [, io] = await handleUnset(['arr[1]'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'bash: unset: arr: cannot unset: readonly variable\n',
    )
    expect(s.arrays.arr).toEqual(['x', 'y'])
  })

  it('unset NAME[0] removes a scalar, a non-zero subscript errors', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ Y: 'sc', Z: 'sc' }) })
    const [, io] = await handleUnset(['Y[0]'], s)
    expect(io.exitCode).toBe(0)
    expect('Y' in s.env).toBe(false)
    const [, io2] = await handleUnset(['Z[1]'], s)
    expect(io2.exitCode).toBe(1)
    expect(decode(io2.stderr as Uint8Array)).toBe('bash: unset: Z: not an array variable\n')
    expect(s.env.Z).toBe('sc')
  })

  it('unset of a negative element outside the extent errors', async () => {
    const s = new Session({ sessionId: 'test' })
    seedVar(s, 'arr', ['x'])
    const [, io] = await handleUnset(['arr[-2]'], s)
    expect(io.exitCode).toBe(1)
    // bash prints only the bracketed part here, not the base name.
    expect(decode(io.stderr as Uint8Array)).toBe('bash: unset: [-2]: bad array subscript\n')
    expect(s.arrays.arr).toEqual(['x'])
    seedVar(s, 'two', ['x', 'y'])
    const [, io2] = await handleUnset(['two[-2]'], s)
    expect(io2.exitCode).toBe(0)
    expect(s.arrays.two).toEqual([null, 'y'])
  })

  it('unset of an element of an unset name is a no-op', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleUnset(['GONE[3]'], s)
    expect(io.exitCode).toBe(0)
  })

  it('unset -z is an invalid option (exit 2)', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleUnset(['-z', 'x'], s)
    expect(io.exitCode).toBe(2)
  })

  it('printenv VAR emits value + newline; exit 1 if missing', () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ X: 'yes' }) })
    const [out, io] = handlePrintenv('X', s)
    expect(decode(out as Uint8Array)).toBe('yes\n')
    expect(io.exitCode).toBe(0)
    const [, io2] = handlePrintenv('MISSING', s)
    expect(io2.exitCode).toBe(1)
  })

  it('printenv with no name lists sorted KEY=VAL', () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ B: '2', A: '1' }) })
    const [out] = handlePrintenv(null, s)
    expect(decode(out as Uint8Array)).toBe('A=1\nB=2\nPWD=/\n')
  })
})

describe('handleReturn / handleLocal', () => {
  it('handleReturn throws ReturnSignal with exit code', () => {
    const s = new Session({ sessionId: 'test' })
    const cs = new CallStack()
    cs.push([], 'f')
    expect(() => handleReturn(['42'], s, cs)).toThrow(ReturnSignal)
    try {
      handleReturn(['42'], s, cs)
    } catch (err) {
      if (err instanceof ReturnSignal) expect(err.exitCode).toBe(42)
    }
  })

  it('bare return propagates the last exit code', () => {
    const s = new Session({ sessionId: 'test' })
    s.lastExitCode = 1
    const cs = new CallStack()
    cs.push([], 'f')
    try {
      handleReturn([], s, cs)
      expect.unreachable()
    } catch (err) {
      if (!(err instanceof ReturnSignal)) throw err
      expect(err.exitCode).toBe(1)
    }
  })

  it('return outside a function fails without a signal', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = handleReturn([], s, new CallStack())
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr))).toContain("can only `return'")
  })

  it('return in a sourced script raises the signal', () => {
    const s = new Session({ sessionId: 'test' })
    s.sourceDepth = 1
    expect(() => handleReturn([], s, null)).toThrow(ReturnSignal)
  })

  it('handleLocal outside a function is refused, as GNU refuses it', async () => {
    // `bash: line 1: local: can only be used in a function`, exit 1 and
    // nothing stored. Storing it globally and exiting 0 is the
    // silent-accept this tier removes.
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleLocal(['X=1'], s)
    expect(io.exitCode).toBe(1)
    expect(s.env.X).toBeUndefined()
  })

  it('handleLocal assigns to session.env under the declare spelling', async () => {
    const s = new Session({ sessionId: 'test' })
    await handleLocal(['X=1'], s, null, null, 'declare')
    expect(s.env.X).toBe('1')
  })
})
