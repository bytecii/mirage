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

import { describe } from 'vitest'
import { expect } from 'vitest'
import { it } from 'vitest'
import { parseBashArgs } from './script.ts'
import { vi } from 'vitest'
import { IOResult } from '../../../io/types.ts'
import { enoent } from '../../../utils/errors.ts'
import { Session } from '../../session/session.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { handleEval } from './index.ts'
import { handleSleep } from './index.ts'
import { handleSource } from './index.ts'
import { decode } from '../../fixtures/builtin_fixture.ts'

describe('parseBashArgs', () => {
  it('ends option parsing at a script file operand', () => {
    const parsed = parseBashArgs(['run.sh', '-x', 'a'])
    expect(parsed.path).toBe('run.sh')
    expect(parsed.argv).toEqual(['-x', 'a'])
    expect(parsed.settings).toEqual([])
  })

  it('takes a flag-shaped file after --', () => {
    const parsed = parseBashArgs(['--', '-weird.sh', 'a'])
    expect(parsed.path).toBe('-weird.sh')
    expect(parsed.argv).toEqual(['a'])
  })

  it('ends option parsing at a single dash', () => {
    expect(parseBashArgs(['-', 'run.sh']).path).toBe('run.sh')
  })

  it('keeps set options from a cluster ending in c', () => {
    const parsed = parseBashArgs(['-xc', 'echo hi', 'name', 'a'])
    expect(parsed.script).toBe('echo hi')
    expect(parsed.argv).toEqual(['name', 'a'])
    expect(parsed.settings).toEqual([['xtrace', true]])
  })

  it('maps set flags to shell options', () => {
    const parsed = parseBashArgs(['-eux', 'run.sh'])
    expect(parsed.path).toBe('run.sh')
    expect(parsed.settings).toEqual([
      ['errexit', true],
      ['nounset', true],
      ['xtrace', true],
    ])
  })

  it('lets the last sign win within one invocation', () => {
    const parsed = parseBashArgs(['-e', '+e', 'run.sh'])
    expect(parsed.settings).toEqual([
      ['errexit', true],
      ['errexit', false],
    ])
  })

  it('keeps every operand positional under -s', () => {
    const parsed = parseBashArgs(['-s', 'A', 'B'])
    expect(parsed.path).toBeNull()
    expect(parsed.script).toBeNull()
    expect(parsed.argv).toEqual(['A', 'B'])
  })

  it('applies -o and its value', () => {
    const parsed = parseBashArgs(['-o', 'pipefail', 'run.sh'])
    expect(parsed.path).toBe('run.sh')
    expect(parsed.settings).toEqual([['pipefail', true]])
  })

  it('consumes a long option value', () => {
    expect(parseBashArgs(['--rcfile', 'rc', 'run.sh']).path).toBe('run.sh')
  })

  it('reports an unsupported short option', () => {
    expect(parseBashArgs(['-Z']).invalid).toBe('-Z')
  })

  it('reports an unsupported long option', () => {
    expect(parseBashArgs(['--nosuch', 'run.sh']).invalid).toBe('--nosuch')
  })

  it('reports -c with no value', () => {
    expect(parseBashArgs(['-c']).needsValue).toBe('-c')
  })
})

describe('handleSleep', () => {
  it('rejects invalid seconds', async () => {
    const [, io] = await handleSleep(['abc'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe("sleep: invalid time interval 'abc'\n")
  })

  it('rejects missing operand', async () => {
    const [, io] = await handleSleep([])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('sleep: missing operand\n')
  })

  it.each(['-1', 'inf', 'Infinity', 'nan', 'NaN', '0x10', '1_0', '1e309', ''])(
    'rejects %j as invalid time interval',
    async (raw) => {
      const [, io] = await handleSleep([raw])
      expect(io.exitCode).toBe(1)
      expect(decode(io.stderr as Uint8Array)).toBe(`sleep: invalid time interval '${raw}'\n`)
    },
  )

  it.each(['0', '0.', '.01', '+0.01', '1e-3'])('accepts %j and exits 0', async (raw) => {
    const [, io] = await handleSleep([raw])
    expect(io.exitCode).toBe(0)
    expect(io.stderr).toBeNull()
  })

  it('sleeps for 0 seconds', async () => {
    const start = Date.now()
    const [, io] = await handleSleep(['0'])
    const elapsed = Date.now() - start
    expect(io.exitCode).toBe(0)
    expect(elapsed).toBeLessThan(50)
  })
})

describe('handleEval', () => {
  it('calls the provided executeFn with joined args', async () => {
    const exec = vi.fn(() => Promise.resolve(new IOResult({ exitCode: 7 })))
    const s = new Session({ sessionId: 'sess' })
    const [, io] = await handleEval(exec, ['echo', 'hi'], s)
    expect(io.exitCode).toBe(7)
    expect(exec).toHaveBeenCalledWith('echo hi', { session: s, sessionId: 'sess' })
  })
})

describe('handleSource', () => {
  it('dispatches read on the path then runs script', async () => {
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const dispatch = vi.fn(() => {
      const data = new TextEncoder().encode('export FOO=bar\n')
      return Promise.resolve([data, new IOResult()] as [Uint8Array, IOResult])
    }) as unknown as DispatchFn
    let executed = ''
    const executeFn = vi.fn((script: string, _opts: { sessionId: string }) => {
      executed = script
      return Promise.resolve(new IOResult())
    })
    const [, io] = await handleSource(dispatch, executeFn, '/script.sh', s)
    expect(io.exitCode).toBe(0)
    expect(executed).toBe('export FOO=bar\n')
    expect(dispatch).toHaveBeenCalled()
  })

  it('returns exit 1 with stderr on read failure', async () => {
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const dispatch = vi.fn(() => Promise.reject(enoent('/missing.sh'))) as unknown as DispatchFn
    const executeFn = vi.fn(() => Promise.resolve(new IOResult()))
    const [, io] = await handleSource(dispatch, executeFn, '/missing.sh', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr instanceof Uint8Array ? io.stderr : null)).toBe(
      'source: /missing.sh: No such file or directory\n',
    )
    expect(executeFn).not.toHaveBeenCalled()
  })

  it('propagates a failure that is not a filesystem error', async () => {
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const dispatch = vi.fn(() =>
      Promise.reject(new Error('token expired')),
    ) as unknown as DispatchFn
    const executeFn = vi.fn(() => Promise.resolve(new IOResult()))
    await expect(handleSource(dispatch, executeFn, '/script.sh', s)).rejects.toThrow(
      'token expired',
    )
    expect(executeFn).not.toHaveBeenCalled()
  })

  it('sets positional args for the script and restores them after', async () => {
    const s = new Session({ sessionId: 'test', cwd: '/', positionalArgs: ['P1', 'P2'] })
    const dispatch = vi.fn(() => {
      const data = new TextEncoder().encode('echo hi\n')
      return Promise.resolve([data, new IOResult()] as [Uint8Array, IOResult])
    }) as unknown as DispatchFn
    let seen: string[] = []
    const executeFn = vi.fn((_script: string, _opts: { sessionId: string }) => {
      seen = [...s.positionalArgs]
      return Promise.resolve(new IOResult())
    })
    await handleSource(dispatch, executeFn, '/script.sh', s, ['AA', 'BB'])
    expect(seen).toEqual(['AA', 'BB'])
    expect(s.positionalArgs).toEqual(['P1', 'P2'])
  })
})
