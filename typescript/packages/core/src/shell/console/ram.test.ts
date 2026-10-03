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
import { RAMConsoleStore } from './ram.ts'
import { Channel } from './types.ts'

describe('cancellable readers', () => {
  it('aborts a parked reader and leaves subsequent reads usable', async () => {
    const store = new RAMConsoleStore()
    const abort = new AbortController()
    const reason = new Error('reader cancelled')
    const waiting = store.wait(0, abort.signal)
    abort.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    await store.append(Channel.STDOUT, new TextEncoder().encode('still usable'))
    await store.wait(0)
  })

  it('rejects an already aborted reader even when data is available', async () => {
    const store = new RAMConsoleStore()
    await store.append(Channel.STDOUT, new Uint8Array([1]))
    const reason = new Error('reader cancelled')
    await expect(store.wait(0, AbortSignal.abort(reason))).rejects.toBe(reason)
  })
})

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('RAMConsoleStore', () => {
  it('assigns increasing seq', async () => {
    const store = new RAMConsoleStore()
    const first = await store.append(Channel.STDOUT, enc('a'))
    const second = await store.append(Channel.STDERR, enc('b'))
    expect([first.seq, second.seq]).toEqual([0, 1])
  })

  it('reads a window and reports the next cursor', async () => {
    const store = new RAMConsoleStore()
    for (const p of ['a', 'b', 'c']) await store.append(Channel.STDOUT, enc(p))
    const [chunks, next, truncated] = await store.readFrom(1)
    expect(chunks.map((c) => dec(c.data))).toEqual(['b', 'c'])
    expect(next).toBe(3)
    expect(truncated).toBe(false)
  })

  it('honours a limit', async () => {
    const store = new RAMConsoleStore()
    for (const p of ['a', 'b', 'c']) await store.append(Channel.STDOUT, enc(p))
    const [chunks, next] = await store.readFrom(0, 2)
    expect(chunks.map((c) => dec(c.data))).toEqual(['a', 'b'])
    expect(next).toBe(2)
  })

  it('reading from the end is empty, not an error', async () => {
    const store = new RAMConsoleStore()
    await store.append(Channel.STDOUT, enc('a'))
    const [chunks, next] = await store.readFrom(1)
    expect(chunks).toEqual([])
    expect(next).toBe(1)
  })

  it('drops the oldest chunks and reports truncation', async () => {
    const store = new RAMConsoleStore(2)
    for (const p of ['a', 'b', 'c']) await store.append(Channel.STDOUT, enc(p))
    const [chunks, , truncated] = await store.readFrom(0)
    expect(truncated).toBe(true)
    expect(chunks.map((c) => dec(c.data))).toEqual(['b', 'c'])
  })

  it('never trims the terminal control chunk', async () => {
    const store = new RAMConsoleStore(2)
    await store.append(Channel.STDOUT, enc('payload'))
    await store.append(Channel.CONTROL, enc('exit:0'))
    const [chunks] = await store.readFrom(0)
    expect(chunks.map((c) => c.channel)).toEqual([Channel.CONTROL])
  })

  it('does not report truncation to a reader still in range', async () => {
    const store = new RAMConsoleStore(2)
    for (const p of ['a', 'b', 'c']) await store.append(Channel.STDOUT, enc(p))
    const [, , truncated] = await store.readFrom(2)
    expect(truncated).toBe(false)
  })

  it('waits until the next append', async () => {
    const store = new RAMConsoleStore()
    let woke = false
    const waiter = store.wait(0).then(() => {
      woke = true
    })
    await Promise.resolve()
    expect(woke).toBe(false)
    await store.append(Channel.STDOUT, enc('a'))
    await waiter
    expect(woke).toBe(true)
  })

  it('returns immediately when data already exists', async () => {
    const store = new RAMConsoleStore()
    await store.append(Channel.STDOUT, enc('a'))
    await store.wait(0)
  })

  it('close releases blocked readers', async () => {
    const store = new RAMConsoleStore()
    const waiter = store.wait(0)
    await store.close()
    await waiter
  })
})
