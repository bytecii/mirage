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
import { RAMIndexCacheStore } from './ram.ts'
import { RedisIndexCacheStore } from './redis.ts'
import type { IndexCacheStore } from './store.ts'

// The contract every store answers identically; only the storage differs.
// `ram.test.ts` alone covered the empty listing, which is how the Redis store
// drifted: Redis has no empty list, so a directory with no children was never
// recorded as listed (#1008); a listing past its TTL read as NOT_FOUND rather
// than EXPIRED, and one written already expired served for up to a second
// (#1022). Mirrors `tests/cache/index/test_store.py`, minus the seed cases,
// since this base store has no `seed`.

const REDIS_URL = process.env.REDIS_URL

function entry(id: string, name: string): IndexEntry {
  return new IndexEntry({ id, name, resourceType: 'file' })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function contract(name: string, make: () => IndexCacheStore, skip: boolean): void {
  describe.skipIf(skip)(`IndexCacheStore contract (${name})`, () => {
    let store: IndexCacheStore

    beforeEach(async () => {
      store = make()
      await store.clear()
    })

    afterEach(async () => {
      await store.clear()
      await store.close()
    })

    it('an empty listing is listed, not missing', async () => {
      await store.setDir('/empty', [])
      const r = await store.listDir('/empty')
      expect(r.status).toBeUndefined()
      expect(r.entries).toEqual([])
    })

    it('an unlisted directory is NOT_FOUND', async () => {
      expect((await store.listDir('/never')).status).toBe(LookupStatus.NOT_FOUND)
    })

    it('a past expiry is EXPIRED at once', async () => {
      const past = new Date(Date.now() - 1000)
      await store.setDir('/d', [['f.txt', entry('f', 'f.txt')]], past)
      expect((await store.listDir('/d')).status).toBe(LookupStatus.EXPIRED)
      expect((await store.get('/d/f.txt')).entry).toBeDefined()
    })

    it('natural expiry is EXPIRED, not missing', async () => {
      const soon = new Date(Date.now() + 200)
      await store.setDir('/d', [['f.txt', entry('f', 'f.txt')]], soon)
      expect((await store.listDir('/d')).entries).toEqual(['/d/f.txt'])
      await sleep(300)
      expect((await store.listDir('/d')).status).toBe(LookupStatus.EXPIRED)
    })

    it('invalidate expires without discarding', async () => {
      await store.setDir('/d', [['f.txt', entry('f', 'f.txt')]])
      await store.invalidate()
      expect((await store.listDir('/d')).status).toBe(LookupStatus.EXPIRED)
      expect((await store.get('/d/f.txt')).entry).toBeDefined()
      expect((await store.listDir('/never')).status).toBe(LookupStatus.NOT_FOUND)
      await store.setDir('/d', [['g.txt', entry('g', 'g.txt')]])
      expect((await store.listDir('/d')).entries).toEqual(['/d/g.txt'])
    })

    it('invalidateDir forgets the listing and its children', async () => {
      await store.setDir('/d', [['f.txt', entry('f', 'f.txt')]])
      await store.invalidateDir('/d')
      expect((await store.listDir('/d')).status).toBe(LookupStatus.NOT_FOUND)
      expect((await store.get('/d/f.txt')).status).toBe(LookupStatus.NOT_FOUND)
    })

    it('clear forgets the invalidation too', async () => {
      await store.setDir('/d', [['f.txt', entry('f', 'f.txt')]])
      await store.invalidate()
      await store.clear()
      expect((await store.listDir('/d')).status).toBe(LookupStatus.NOT_FOUND)
      await store.setDir('/d', [['f.txt', entry('f', 'f.txt')]])
      expect((await store.listDir('/d')).entries).toEqual(['/d/f.txt'])
    })
  })
}

contract('ram', () => new RAMIndexCacheStore({ ttl: 60 }), false)
contract(
  'redis',
  () =>
    new RedisIndexCacheStore({
      ...(REDIS_URL !== undefined ? { url: REDIS_URL } : {}),
      keyPrefix: `mirage:idx:contract:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`,
      ttl: 60,
    }),
  REDIS_URL === undefined,
)
