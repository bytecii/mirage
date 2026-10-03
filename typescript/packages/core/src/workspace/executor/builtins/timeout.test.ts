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

import { sleep } from '../../abort.ts'
import type { ExecuteFn } from '../types.ts'
import { describe } from 'vitest'
import { expect } from 'vitest'
import { it } from 'vitest'
import { IOResult } from '../../../io/types.ts'
import { materialize } from '../../../io/types.ts'
import { Session } from '../../session/session.ts'
import { handleTimeout } from './index.ts'
import { parseDuration } from './timeout.ts'
import { decode, fakeShell } from '../../fixtures/builtin_fixture.ts'

describe('handleTimeout', () => {
  const session = new Session({ sessionId: 'test' })

  it('parses duration units', () => {
    expect(parseDuration('1')).toBe(1)
    expect(parseDuration('0.5')).toBe(0.5)
    expect(parseDuration('2s')).toBe(2)
    expect(parseDuration('2m')).toBe(120)
    expect(parseDuration('1h')).toBe(3600)
    expect(parseDuration('1d')).toBe(86400)
    expect(parseDuration('.5')).toBe(0.5)
  })

  it('rejects garbage durations', () => {
    expect(parseDuration('xx')).toBeNull()
    expect(parseDuration('-1')).toBeNull()
    expect(parseDuration('1x')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })

  it('passes through when the command finishes in time', async () => {
    const shell = fakeShell([3])
    const [stdout, io] = await handleTimeout(shell.fn, ['5', 'wc', '-l'], session)
    expect(shell.lines).toEqual(['wc -l'])
    expect(io.exitCode).toBe(3)
    expect(decode(stdout as Uint8Array)).toBe('ran:wc -l\n')
  })

  it('cancels and joins the inner execution before returning 124', async () => {
    let cleaned = false
    const slow: ExecuteFn = async (_line, options) => {
      try {
        await sleep(10000, options.signal)
        return new IOResult()
      } finally {
        cleaned = true
      }
    }
    const [, io] = await handleTimeout(slow, ['0.01', 'sleep', '10'], session)
    expect(io.exitCode).toBe(124)
    expect(cleaned).toBe(true)
  })

  it('invalid duration exits 125', async () => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, ['xx', 'sleep', '1'], session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe("timeout: invalid time interval 'xx'\n")
    expect(shell.lines).toEqual([])
  })

  it('missing operand exits 125', async () => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, ['5'], session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe('timeout: missing operand\n')
  })

  it('signal option is rejected', async () => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, ['-s', 'KILL', '1', 'sleep', '3'], session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe("timeout: unsupported option -- '-s'\n")
  })
})
