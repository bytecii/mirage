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
import { materialize } from '../../../io/types.ts'
import { Session } from '../../session/session.ts'
import { handleXargs } from './index.ts'
import { decode, fakeShell, aBC, ab } from '../../fixtures/builtin_fixture.ts'

describe('handleXargs', () => {
  const session = new Session({ sessionId: 'test' })

  it('-n1 batches one arg per run', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-n1', 'echo'], session, aBC())
    expect(shell.lines).toEqual(['echo a', 'echo b', 'echo c'])
    expect(io.exitCode).toBe(0)
  })

  it('failing invocation exits 123 but continues', async () => {
    const shell = fakeShell([1, 0])
    const [, io] = await handleXargs(shell.fn, ['-n1', 'wc'], session, ab())
    expect(shell.lines).toEqual(['wc a', 'wc b'])
    expect(io.exitCode).toBe(123)
  })

  it('command-not-found stops with 127', async () => {
    const shell = fakeShell([127, 0])
    const [, io] = await handleXargs(shell.fn, ['-n1', 'nope'], session, ab())
    expect(shell.lines).toEqual(['nope a'])
    expect(io.exitCode).toBe(127)
  })

  it('-r skips the run on empty input', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-r', 'echo', 'hi'], session, new Uint8Array())
    expect(shell.lines).toEqual([])
    expect(io.exitCode).toBe(0)
  })

  it('-0 splits on NUL', async () => {
    const shell = fakeShell()
    await handleXargs(shell.fn, ['-0', 'echo'], session, new TextEncoder().encode('a b\0c\0'))
    expect(shell.lines).toEqual(["echo 'a b' c"])
  })

  it('-d splits on the delimiter', async () => {
    const shell = fakeShell()
    await handleXargs(shell.fn, ['-d,', 'echo'], session, new TextEncoder().encode('a,b,c'))
    expect(shell.lines).toEqual(['echo a b c'])
  })

  it('invalid option exits 1 without running', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-q', 'echo'], session, ab())
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe("xargs: invalid option -- 'q'\n")
    expect(shell.lines).toEqual([])
  })

  it('-n0 is rejected', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-n0', 'echo'], session, ab())
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(
      'xargs: value 0 for -n option should be >= 1\n',
    )
  })
})
