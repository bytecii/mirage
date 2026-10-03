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
import { describe } from 'vitest'
import { expect } from 'vitest'
import { it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { Session } from '../../session/session.ts'
import { handleRead } from './index.ts'
import { decode } from '../../fixtures/builtin_fixture.ts'

describe('handleRead', () => {
  it('reads single line into one variable', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('hello world\nrest\n')
    const [, io] = await handleRead(['LINE'], s, stdin)
    expect(io.exitCode).toBe(0)
    expect(s.env.LINE).toBe('hello world')
  })

  it('splits whitespace across multiple variables', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('alice 30 engineer\n')
    await handleRead(['NAME', 'AGE', 'ROLE'], s, stdin)
    expect(s.env.NAME).toBe('alice')
    expect(s.env.AGE).toBe('30')
    expect(s.env.ROLE).toBe('engineer')
  })

  it('last variable absorbs remainder', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('one two three four five\n')
    await handleRead(['A', 'B', 'C'], s, stdin)
    expect(s.env.A).toBe('one')
    expect(s.env.B).toBe('two')
    expect(s.env.C).toBe('three four five')
  })

  it('EOF / null stdin: assign empty + exit 1', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleRead(['X', 'Y'], s, null)
    expect(io.exitCode).toBe(1)
    expect(s.env.X).toBe('')
    expect(s.env.Y).toBe('')
  })

  it('reads from AsyncIterable stdin', async () => {
    const s = new Session({ sessionId: 'test' })
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* gen(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('streamed line\nignored\n')
    }
    await handleRead(['L'], s, gen())
    expect(s.env.L).toBe('streamed line')
  })

  it('a NEW stdin source replaces a stale exhausted buffer', async () => {
    const s = new Session({ sessionId: 'test' })
    const first = new TextEncoder().encode('first\n')
    await handleRead(['X'], s, first)
    await handleRead(['X2'], s, first)
    expect(s.env.X2).toBe('')
    const second = new TextEncoder().encode('second\n')
    const [, io] = await handleRead(['Y'], s, second)
    expect(io.exitCode).toBe(0)
    expect(s.env.Y).toBe('second')
  })

  it('the SAME stdin source keeps advancing through lines', async () => {
    const s = new Session({ sessionId: 'test' })
    const shared = new TextEncoder().encode('a\nb\n')
    await handleRead(['P'], s, shared)
    await handleRead(['Q'], s, shared)
    expect(s.env.P).toBe('a')
    expect(s.env.Q).toBe('b')
  })

  it('a scalar read replaces an array of the same name', async () => {
    const s = new Session({ sessionId: 'test' })
    seedVar(s, 'A', ['x', 'y'])
    const stdin = new TextEncoder().encode('one\n')
    await handleRead(['A'], s, stdin)
    expect(s.env.A).toBe('one')
    expect(s.arrays.A).toBeUndefined()
  })
})

describe('handleRead options', () => {
  it('-r is consumed, not a variable', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('hello world\n')
    const [, io] = await handleRead(['-r', 'v'], s, stdin)
    expect(io.exitCode).toBe(0)
    expect(s.env.v).toBe('hello world')
    expect('-r' in s.env).toBe(false)
  })

  it('unknown option errors like bash', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleRead(['-q', 'v'], s, new TextEncoder().encode('x\n'))
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr))).toBe('read: -q: invalid option\n')
  })

  it('defaults to REPLY', async () => {
    const s = new Session({ sessionId: 'test' })
    await handleRead([], s, new TextEncoder().encode('hi\n'))
    expect(s.env.REPLY).toBe('hi')
  })
})
