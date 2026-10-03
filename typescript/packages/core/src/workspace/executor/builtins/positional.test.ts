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

import { makeVar } from '../../../shell/variable.ts'
import { seedVar } from '../../../workspace/session/state.ts'
import { VarAttr } from '../../../shell/variable.ts'
import { varsFromEnv } from '../../../workspace/session/session.ts'
import { handleGetopts, handleSet, handleShift } from './positional.ts'
import { handleReturn } from './flow.ts'
import { describe } from 'vitest'
import { expect } from 'vitest'
import { it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { CallStack } from '../../../shell/call_stack.ts'
import { Session } from '../../session/session.ts'
import { ReturnSignal } from '../control.ts'
import { decode } from '../../fixtures/builtin_fixture.ts'

describe('handleShift', () => {
  it('shifts call-stack positional args', () => {
    const cs = new CallStack()
    cs.push(['a', 'b', 'c', 'd'])
    handleShift(['2'], cs, null)
    expect(cs.getAllPositional()).toEqual(['c', 'd'])
  })

  it('shifts session.positionalArgs when call stack empty', () => {
    const cs = new CallStack()
    const s = new Session({ sessionId: 'test', positionalArgs: ['x', 'y', 'z'] })
    handleShift(['1'], cs, s)
    expect(s.positionalArgs).toEqual(['y', 'z'])
  })
})

describe('handleGetopts', () => {
  it('single flag sets var and advances OPTIND', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '-a'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('iterates two flags then stops', async () => {
    const s = new Session({ sessionId: 't' })
    const args = ['ab', 'o', '-a', '-b']
    await handleGetopts(args, s)
    expect([s.env.o, s.env.OPTIND]).toEqual(['a', '2'])
    await handleGetopts(args, s)
    expect([s.env.o, s.env.OPTIND]).toEqual(['b', '3'])
    const [, io3] = await handleGetopts(args, s)
    expect(io3.exitCode).toBe(1)
    expect(s.env.o).toBe('?')
  })

  it('separate optarg', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:b', 'o', '-a', 'foo', '-b'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTARG).toBe('foo')
    expect(s.env.OPTIND).toBe('3')
  })

  it('attached optarg', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:', 'o', '-afoo'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTARG).toBe('foo')
    expect(s.env.OPTIND).toBe('2')
  })

  it('combined flags share OPTIND until the word is done', async () => {
    const s = new Session({ sessionId: 't' })
    const args = ['abc', 'o', '-abc']
    await handleGetopts(args, s)
    expect([s.env.o, s.env.OPTIND]).toEqual(['a', '1'])
    await handleGetopts(args, s)
    expect([s.env.o, s.env.OPTIND]).toEqual(['b', '1'])
    await handleGetopts(args, s)
    expect([s.env.o, s.env.OPTIND]).toEqual(['c', '2'])
  })

  it('invalid option, non-silent', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '-x'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(decode(io.stderr as Uint8Array)).toBe('bash: illegal option -- x\n')
    expect(s.env.OPTIND).toBe('2')
  })

  it('invalid option, silent → OPTARG set, no stderr', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts([':ab', 'o', '-x'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(s.env.OPTARG).toBe('x')
    expect(io.stderr).toBeNull()
  })

  it('missing arg, non-silent', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:', 'o', '-a'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(decode(io.stderr as Uint8Array)).toBe('bash: option requires an argument -- a\n')
  })

  it('missing arg, silent → name ":" and OPTARG', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts([':a:', 'o', '-a'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe(':')
    expect(s.env.OPTARG).toBe('a')
    expect(io.stderr).toBeNull()
  })

  it('non-option word stops without advancing', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', 'foo', '-a'], s)
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('1')
  })

  it('double dash is consumed then stops', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '--', '-a'], s)
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('2')
  })

  it('no args stops', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o'], s)
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('1')
  })

  it('reads positional args when no explicit args', async () => {
    const s = new Session({ sessionId: 't', positionalArgs: ['-a', '-b'] })
    const [, io] = await handleGetopts(['ab', 'o'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
  })

  it('usage error on too few operands', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe('getopts: usage: getopts optstring name [arg]\n')
  })

  it('OPTIND reset reparses', async () => {
    const s = new Session({ sessionId: 't', positionalArgs: ['-a', '-b'] })
    await handleGetopts(['ab', 'o'], s)
    await handleGetopts(['ab', 'o'], s)
    const [, stop] = await handleGetopts(['ab', 'o'], s)
    expect(stop.exitCode).toBe(1)
    seedVar(s, 'OPTIND', '1')
    s.positionalArgs = ['-b', '-a']
    const [, io] = await handleGetopts(['ab', 'o'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('b')
  })

  it('does not read past the end of a shorter reused word', async () => {
    const s = new Session({ sessionId: 't' })
    await handleGetopts(['ab', 'o', '-ab'], s)
    const [, io] = await handleGetopts(['ab', 'o', '-a'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('treats a nonpositive OPTIND as a restart at argument 1', async () => {
    const s = new Session({ sessionId: 't', positionalArgs: ['-a', '-b'] })
    seedVar(s, 'OPTIND', '0')
    const [, io] = await handleGetopts(['ab', 'o'], s)
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('rejects an invalid destination identifier', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['a', 'bad-name', '-a'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toContain('not a valid identifier')
    expect(s.env['bad-name']).toBeUndefined()
  })

  it('does not overwrite a readonly destination', async () => {
    const s = new Session({
      sessionId: 't',
      vars: { o: makeVar('orig', new Set([VarAttr.Readonly])) },
    })
    const [, io] = await handleGetopts(['a', 'o', '-a'], s)
    expect(io.exitCode).toBe(1)
    expect(s.env.o).toBe('orig')
    expect(decode(io.stderr as Uint8Array)).toContain('readonly variable')
  })

  it('suppresses diagnostics when OPTERR=0', async () => {
    const s = new Session({ sessionId: 't', vars: varsFromEnv({ OPTERR: '0' }) })
    const [, io] = await handleGetopts(['ab', 'o', '-x'], s)
    expect(s.env.o).toBe('?')
    expect(io.stderr ?? null).toBeNull()
  })

  it('scans the function frame positional parameters', async () => {
    const s = new Session({ sessionId: 't' })
    const cs = new CallStack()
    cs.push(['-a', '-b'], 'f')
    await handleGetopts(['ab', 'o'], s, cs)
    expect(s.env.o).toBe('a')
    await handleGetopts(['ab', 'o'], s, cs)
    expect(s.env.o).toBe('b')
  })

  it('propagates the cursor across fork()', async () => {
    const s = new Session({ sessionId: 't' })
    await handleGetopts(['ab', 'o', '-ab'], s)
    const forked = s.fork()
    expect(forked.getoptsPos).toBe(s.getoptsPos)
    expect(forked.getoptsOptind).toBe(s.getoptsOptind)
  })
})

describe('handleSet', () => {
  it('no args → print env', () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ A: '1' }) })
    const [out] = handleSet([], s)
    expect(decode(out as Uint8Array)).toBe('A=1\nPWD=/\n')
  })

  it('"-- a b" sets positional args', () => {
    const s = new Session({ sessionId: 'test' })
    handleSet(['--', 'a', 'b'], s)
    expect(s.positionalArgs).toEqual(['a', 'b'])
  })
})

describe('handleShift / handleReturn argument checks', () => {
  it('shift with a non-numeric arg errors like bash', async () => {
    const [, io] = handleShift(['x'], null, new Session({ sessionId: 'test' }))
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('shift: x: numeric argument required\n')
  })

  it('shift with two args errors', async () => {
    const [, io] = handleShift(['1', '2'], null, new Session({ sessionId: 'test' }))
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('shift: too many arguments\n')
  })

  it('return with a non-numeric arg raises 2 with a message', () => {
    const s = new Session({ sessionId: 'test' })
    const cs = new CallStack()
    cs.push([], 'f')
    try {
      handleReturn(['x'], s, cs)
      expect.unreachable()
    } catch (err) {
      if (!(err instanceof ReturnSignal)) throw err
      expect(err.exitCode).toBe(2)
      expect(decode(err.stderr)).toBe('return: x: numeric argument required\n')
    }
  })
})
