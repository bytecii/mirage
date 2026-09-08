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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexEntry, LookupStatus } from './config.ts'
import { RedisIndexCacheStore, type RedisClientLike } from './redis.ts'

describe('RedisIndexCacheStore default keyPrefix', () => {
  it('namespaces keys under mirage:index: by default', () => {
    const store = new RedisIndexCacheStore()
    const prefix = (store as unknown as { entryPrefix: string }).entryPrefix
    expect(prefix).toBe('mirage:index:mirage:idx:entry:')
  })
})

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function entry(id: string, name: string, resourceType = 'file'): IndexEntry {
  return new IndexEntry({ id, name, resourceType })
}

describe.skipIf(skip)('RedisIndexCacheStore', () => {
  let store: RedisIndexCacheStore
  const prefix = `mirage:idx:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`

  beforeEach(async () => {
    store = new RedisIndexCacheStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: prefix, ttl: 600 }
        : { keyPrefix: prefix, ttl: 600 },
    )
    await store.clear()
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  it('get returns NOT_FOUND when missing', async () => {
    const r = await store.get('/nope')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('put + get round-trips entry metadata', async () => {
    const extra = { drive_id: 'drive-a', nested: { slug: 'alpha', tags: ['x', 'y'] } }
    await store.put('/a', new IndexEntry({ id: 'id-a', name: 'a', resourceType: 'file', extra }))
    const r = await store.get('/a')
    expect(r.entry?.id).toBe('id-a')
    expect(r.entry?.name).toBe('a')
    expect(r.entry?.indexTime).not.toBe('')
    expect(r.entry?.extra).toEqual(extra)
  })

  it('setDir + get round-trips metadata and default empty extra', async () => {
    const extra = { attachment: { url: 'https://example.test/file', size: 42 } }
    await store.setDir('/dir', [
      [
        'with-extra',
        new IndexEntry({ id: 'id-extra', name: 'with-extra', resourceType: 'file', extra }),
      ],
      ['without-extra', entry('id-empty', 'without-extra')],
    ])

    expect((await store.get('/dir/with-extra')).entry?.extra).toEqual(extra)
    expect((await store.get('/dir/without-extra')).entry?.extra).toEqual({})
  })

  it('setDir stores entries and listDir preserves insertion (readdir) order', async () => {
    await store.setDir('/', [
      ['b', entry('id-b', 'b')],
      ['a', entry('id-a', 'a')],
    ])
    const list = await store.listDir('/')
    expect(list.entries).toEqual(['/b', '/a'])
  })

  it('listDir NOT_FOUND when unset', async () => {
    const r = await store.listDir('/ghost')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('invalidateDir removes children entry', async () => {
    await store.setDir('/x', [['f', entry('id-f', 'f')]])
    await store.invalidateDir('/x')
    const r = await store.listDir('/x')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('setDir sets TTL based on default ttl', async () => {
    const s = new RedisIndexCacheStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: prefix, ttl: 1 }
        : { keyPrefix: prefix, ttl: 1 },
    )
    try {
      await s.setDir('/tmp', [['x', entry('id-x', 'x')]])
      expect((await s.listDir('/tmp')).entries).toEqual(['/tmp/x'])
      await new Promise((r) => setTimeout(r, 1100))
      const r = await s.listDir('/tmp')
      expect(r.status).toBe(LookupStatus.EXPIRED)
    } finally {
      await s.clear()
      await s.close()
    }
  })

  it('invalidatePrefix drops nested listings', async () => {
    await store.setDir('/chan/day', [['chat.jsonl', entry('1', 'chat.jsonl')]])
    await store.setDir('/chan/day/files', [['a.png', entry('2', 'a.png')]])
    await store.invalidatePrefix('/chan/day')
    expect((await store.listDir('/chan/day')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/chan/day/files')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.get('/chan/day/files/a.png')).status).toBe(LookupStatus.NOT_FOUND)
  })

  it('invalidatePrefix respects the path boundary', async () => {
    await store.setDir('/chan/day', [['a', entry('1', 'a')]])
    await store.setDir('/chan/daytime', [['b', entry('2', 'b')]])
    await store.invalidatePrefix('/chan/day')
    expect((await store.listDir('/chan/day')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/chan/daytime')).entries).toEqual(['/chan/daytime/b'])
  })

  it('invalidatePrefix handles glob metacharacters', async () => {
    await store.setDir('/chan/a[1]', [['x', entry('1', 'x')]])
    await store.setDir('/chan/ab', [['y', entry('2', 'y')]])
    await store.invalidatePrefix('/chan/a[1]')
    expect((await store.listDir('/chan/a[1]')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/chan/ab')).entries).toEqual(['/chan/ab/y'])
  })

  it('clear wipes everything under prefix', async () => {
    await store.put('/a', entry('id-a', 'a'))
    await store.setDir('/', [['a', entry('id-a', 'a')]])
    await store.clear()
    expect((await store.get('/a')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/')).status).toBe(LookupStatus.NOT_FOUND)
  })
})

describe('deferred Redis seeds', () => {
  function client() {
    const pipeline: ReturnType<RedisClientLike['multi']> = {
      set: vi.fn(),
      del: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    }
    const value: RedisClientLike = {
      get: vi.fn().mockResolvedValue(null),
      mGet: vi.fn().mockResolvedValue([null, null]),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      multi: () => pipeline,
      scanIterator: () => {
        throw new Error('unexpected scan')
      },
      connect: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
      isOpen: true,
    }
    return { value, pipeline }
  }

  it('retains failed seeds for a close retry', async () => {
    const { value, pipeline } = client()
    vi.mocked(pipeline.exec).mockRejectedValueOnce(new Error('retry'))
    vi.mocked(value.get).mockResolvedValue('g')
    const store = new RedisIndexCacheStore({ client: value })
    store.seed(
      new Map([['/a', entry('a', 'a')]]),
      new Map([['/', ['/a']]]),
      new Date(Date.now() + 3600000),
    )
    await expect(store.close()).rejects.toThrow('retry')
    await store.close()
    await store.close()
    expect(pipeline.exec).toHaveBeenCalledTimes(2)
    const writes = vi.mocked(pipeline.set).mock.calls
    expect(writes.slice(0, 2)).toEqual(writes.slice(2))
    expect(value.quit).not.toHaveBeenCalled()
  })

  it('flushes a seed once across concurrent readers', async () => {
    const { value, pipeline } = client()
    const store = new RedisIndexCacheStore({ client: value })
    store.seed(
      new Map([['/a', entry('a', 'a')]]),
      new Map([['/', ['/a']]]),
      new Date(Date.now() + 3600000),
    )
    await Promise.all([store.get('/a'), store.get('/a')])
    expect(pipeline.exec).toHaveBeenCalledTimes(1)
  })

  it('keeps listings stale when their generation key is evicted', async () => {
    const { value, pipeline } = client()
    const raw = JSON.stringify({ entries: [], expires_at: 4102444800, generation: 'old' })
    vi.mocked(value.mGet).mockResolvedValue([raw, null])
    const store = new RedisIndexCacheStore({ client: value })
    expect((await store.listDir('/old')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/new', [])
    const generation = vi.mocked(value.set).mock.calls[0]?.[1]
    expect(generation).toBeDefined()
    expect(generation).not.toBe('old')
    expect(pipeline.set).toHaveBeenCalled()
    vi.mocked(value.mGet).mockResolvedValue([raw, generation ?? null])
    expect((await store.listDir('/old')).status).toBe(LookupStatus.EXPIRED)
  })

  it('reads a listing and its invalidation generation in one request', async () => {
    const { value } = client()
    vi.mocked(value.mGet).mockResolvedValue([
      JSON.stringify({ entries: [], expires_at: 4102444800, generation: 'g' }),
      'g',
    ])
    const store = new RedisIndexCacheStore({ client: value })
    expect((await store.listDir('/')).entries).toEqual([])
    expect(value.mGet).toHaveBeenCalledTimes(1)
    expect(value.get).not.toHaveBeenCalled()
  })
})
