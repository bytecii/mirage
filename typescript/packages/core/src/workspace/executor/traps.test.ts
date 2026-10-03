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

import { expect, it } from 'vitest'
import { IOResult } from '../../io/types.ts'
import { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { finishShell } from './traps.ts'

it('awaits cleanup and preserves the body status and IO metadata', async () => {
  const session = new Session({ sessionId: 'test' })
  session.exitTrap = 'cleanup'
  session.evalDepth = 3
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const enc = new TextEncoder()
  let finished = false
  const pending = finishShell(
    async (command) => {
      expect(command).toBe('cleanup')
      expect(session.lastExitCode).toBe(7)
      entered()
      await gate
      return new IOResult({
        stdout: enc.encode('cleanup'),
        stderr: enc.encode('err'),
        exitCode: 1,
        writes: { '/after': enc.encode('done') },
      })
    },
    session,
    [
      enc.encode('body'),
      new IOResult({ exitCode: 7, reads: { '/before': enc.encode('body') } }),
      new ExecutionNode({ exitCode: 7 }),
    ],
  ).then((result) => {
    finished = true
    return result
  })
  await started
  expect(finished).toBe(false)
  release()
  const [out, io, node] = await pending
  expect(new TextDecoder().decode(out as Uint8Array)).toBe('bodycleanup')
  expect(await io.stderrStr()).toBe('err')
  expect([io.exitCode, node.exitCode, session.lastExitCode]).toEqual([7, 7, 7])
  expect(Object.keys(io.reads)).toEqual(['/before'])
  expect(Object.keys(io.writes)).toEqual(['/after'])
  expect(session.evalDepth).toBe(3)
  expect(session.exitTrap).toBeNull()
})

it('propagates cancellation from cleanup and clears transient state', async () => {
  const session = new Session({ sessionId: 'test' })
  session.exitTrap = 'cleanup'
  session.evalDepth = 3
  const abort = new AbortController()
  session.abortSignal = abort.signal
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let stopped = false
  const pending = finishShell(
    async (_command, opts) => {
      entered()
      try {
        await new Promise<void>((_resolve, reject) => {
          opts.session?.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      } finally {
        stopped = true
      }
      return new IOResult()
    },
    session,
    [null, new IOResult(), new ExecutionNode()],
  )
  await started
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  abort.abort()
  await rejected
  expect(stopped).toBe(true)
  expect(session.evalDepth).toBe(3)
  expect(session.runningExitTrap).toBe(false)
  expect(session.exitTrap).toBeNull()
})
