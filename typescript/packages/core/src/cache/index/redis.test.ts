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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IndexEntry, LookupStatus } from './config.ts'
import { type ListingDocument, type RedisClientLike, RedisIndexCacheStore } from './redis.ts'

function rawClient(store: RedisIndexCacheStore): Promise<RedisClientLike> {
  return (store as unknown as { client: () => Promise<RedisClientLike> }).client()
}

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
      // Freshness is decided from the listing's own stamp, and the key is
      // kept past it, so this is EXPIRED as on RAM, never NOT_FOUND.
      expect((await s.listDir('/tmp')).status).toBe(LookupStatus.EXPIRED)
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

  // The one wire format: what pydantic writes for the Python IndexEntry,
  // snake_case and every field. `test_redis.py` pins the same literal, so an
  // entry either language writes is one the other reads (#1020).
  it('writes the entry JSON Python writes', async () => {
    await store.put(
      '/a.txt',
      new IndexEntry({
        id: '/a.txt',
        name: 'a.txt',
        resourceType: 'file',
        remoteTime: '2026-01-01T00:00:00Z',
        indexTime: '2026-01-01T00:00:00Z',
        size: 6,
      }),
    )
    const c = await rawClient(store)
    expect(await c.get(`${prefix}mirage:idx:entry:/a.txt`)).toBe(
      '{"id":"/a.txt","name":"a.txt","resource_type":"file","remote_time":"2026-01-01T00:00:00Z","index_time":"2026-01-01T00:00:00Z","vfs_name":"","size":6,"extra":{}}',
    )
  })

  it('reads the entry JSON Python writes', async () => {
    const c = await rawClient(store)
    await c.set(
      `${prefix}mirage:idx:entry:/b.txt`,
      '{"id":"/b.txt","name":"b.txt","resource_type":"file","remote_time":"","index_time":"2026-01-01T00:00:00Z","vfs_name":"","size":null,"extra":{"size_bytes":9}}',
    )
    const r = await store.get('/b.txt')
    expect(r.entry?.resourceType).toBe('file')
    expect(r.entry?.indexTime).toBe('2026-01-01T00:00:00Z')
    expect(r.entry?.size).toBeNull()
    expect(r.entry?.extra).toEqual({ size_bytes: 9 })
  })

  it('stores a listing as one document with its stamps', async () => {
    await store.setDir('/d', [['f', entry('id-f', 'f')]])
    const c = await rawClient(store)
    const raw = await c.get(`${prefix}mirage:idx:children:/d`)
    const listing = JSON.parse(raw ?? '{}') as ListingDocument
    expect(listing.children).toEqual(['/d/f'])
    expect(listing.expires_at - listing.written_at).toBeCloseTo(600, 3)
  })

  it('clear wipes everything under prefix', async () => {
    await store.put('/a', entry('id-a', 'a'))
    await store.setDir('/', [['a', entry('id-a', 'a')]])
    await store.clear()
    expect((await store.get('/a')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/')).status).toBe(LookupStatus.NOT_FOUND)
  })
})
