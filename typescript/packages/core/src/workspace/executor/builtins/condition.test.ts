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
import { vi } from 'vitest'
import { IOResult } from '../../../io/types.ts'
import { FileStat } from '../../../types.ts'
import { MountMode } from '../../../types.ts'
import { MountRegistry } from '../../mount/registry.ts'
import { Namespace } from '../../mount/namespace/namespace.ts'
import { Session } from '../../session/session.ts'
import type { ResolveFn } from '../../dispatcher/index.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { handleTest } from './index.ts'

describe('handleTest', () => {
  const dispatch = vi.fn<DispatchFn>(() =>
    Promise.resolve<[unknown, IOResult]>([new FileStat({ name: 'x' }), new IOResult()]),
  )
  const session = new Session({ sessionId: 'test' })
  const testResolve: ResolveFn = () => Promise.reject(new Error('unused'))
  const testNamespace = () => new Namespace(new MountRegistry({}, MountMode.READ), testResolve)

  it('-z on empty string → true (exit 0)', async () => {
    const [, io] = await handleTest(dispatch, testNamespace(), ['-z', ''], session)
    expect(io.exitCode).toBe(0)
  })

  it('-z on non-empty → false (exit 1)', async () => {
    const [, io] = await handleTest(dispatch, testNamespace(), ['-z', 'x'], session)
    expect(io.exitCode).toBe(1)
  })

  it('integer comparison -eq', async () => {
    const [, io] = await handleTest(dispatch, testNamespace(), ['3', '-eq', '3'], session)
    expect(io.exitCode).toBe(0)
    const [, io2] = await handleTest(dispatch, testNamespace(), ['3', '-eq', '4'], session)
    expect(io2.exitCode).toBe(1)
  })

  it('string equality =', async () => {
    const [, io] = await handleTest(dispatch, testNamespace(), ['foo', '=', 'foo'], session)
    expect(io.exitCode).toBe(0)
  })

  it('-f relative operand resolves against session.cwd', async () => {
    const spy = vi.fn<DispatchFn>((op, scope) => {
      const ps = scope
      if (ps.virtual === '/data/plain.txt') {
        return Promise.resolve<[unknown, IOResult]>([
          new FileStat({ name: 'plain.txt' }),
          new IOResult(),
        ])
      }
      return Promise.reject(new Error(`not found: ${ps.virtual}`))
    })
    const s = new Session({ sessionId: 'test' })
    s.cwd = '/data'
    const [, io] = await handleTest(spy, testNamespace(), ['-f', 'plain.txt'], s)
    expect(io.exitCode).toBe(0)
    const [, io2] = await handleTest(spy, testNamespace(), ['-f', 'missing.txt'], s)
    expect(io2.exitCode).toBe(1)
  })

  it('-f empty operand is false without dispatch', async () => {
    const spy = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([new FileStat({ name: 'x' }), new IOResult()]),
    )
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleTest(spy, testNamespace(), ['-f', ''], s)
    expect(io.exitCode).toBe(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('-d relative operand resolves against session.cwd', async () => {
    const spy = vi.fn<DispatchFn>((op, scope) => {
      const ps = scope
      if (op === 'readdir' && ps.virtual === '/data/sub') {
        return Promise.resolve<[unknown, IOResult]>([['a.txt'], new IOResult()])
      }
      return Promise.reject(new Error(`not found: ${ps.virtual}`))
    })
    const s = new Session({ sessionId: 'test' })
    s.cwd = '/data'
    const [, io] = await handleTest(spy, testNamespace(), ['-d', 'sub'], s)
    expect(io.exitCode).toBe(0)
  })
})
