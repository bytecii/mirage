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
import { entryOrWarm } from './warm.ts'

describe('RedisIndexCacheStore default keyPrefix', () => {
  it('namespaces keys under mirage:index: by default', () => {
    const store = new RedisIndexCacheStore()
    const prefix = (store as unknown as { entryPrefix: string }).entryPrefix
    expect(prefix).toBe('mirage:index:mirage:idx:entry:v2:')
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

  async function redis(): Promise<
    RedisClientLike & { rPush: (key: string, value: string) => Promise<number> }
  > {
    return (
      store as unknown as {
        client: () => Promise<
          RedisClientLike & { rPush: (key: string, value: string) => Promise<number> }
        >
      }
    ).client()
  }

  async function legacyClear(): Promise<void> {
    const client = await redis()
    // These are the two scans performed by an unmodified v1 worker.
    for (const namespace of ['entry', 'children']) {
      for await (const batch of client.scanIterator({
        MATCH: `${prefix}mirage:idx:${namespace}:*`,
      })) {
        const keys = Array.isArray(batch) ? batch : [batch]
        if (keys.length > 0) await client.del(keys)
      }
    }
  }

  it('batches cold snapshot directory tokens in a bounded number of requests', async () => {
    const client = await redis()
    const paths = Array.from({ length: 100 }, (_, i) => `/dir-${String(i)}`)
    const get = vi.spyOn(client, 'get')
    const set = vi.spyOn(client, 'set')
    const mGet = vi.spyOn(client, 'mGet')
    const multi = client.multi.bind(client)
    const commands: number[] = []
    let executions = 0
    const transactions = vi.spyOn(client, 'multi').mockImplementation(() => {
      const pipeline = multi()
      const index = commands.length
      commands.push(0)
      const write = pipeline.set.bind(pipeline)
      pipeline.set = (key, value, options) => {
        commands[index] = (commands[index] ?? 0) + 1
        return write(key, value, options)
      }
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = async () => {
        executions += 1
        return exec()
      }
      return pipeline
    })
    try {
      const deadline = new Date(Date.now() + 365 * 24 * 3600000)
      store.seed(new Map(), new Map(paths.map((path) => [path, []])), deadline)
      store.seed(new Map(), new Map([['/dir-0', []]]), deadline)
      await store.entries()
      expect(get).toHaveBeenCalledTimes(1)
      expect(set).toHaveBeenCalledTimes(1)
      expect(mGet).toHaveBeenCalledTimes(1)
      expect(mGet.mock.calls.map(([keys]) => keys.length)).toEqual([100])
      expect(transactions).toHaveBeenCalledTimes(2)
      expect(executions).toBe(2)
      expect(commands).toEqual([100, 101])
    } finally {
      get.mockRestore()
      set.mockRestore()
      mGet.mockRestore()
      transactions.mockRestore()
    }
    expect((await store.listDir('/dir-0')).entries).toEqual([])
    expect((await store.listDir('/dir-99')).entries).toEqual([])
  })

  it('keeps parallel directory refills fresh on a cold store', async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/dir-${String(i)}`)
    await Promise.all(paths.map((path) => store.setDir(path, [['a', entry('a', 'a')]])))
    for (const path of paths) {
      expect((await store.listDir(path)).entries).toEqual([`${path}/a`])
    }
    await store.invalidate()
    await Promise.all(paths.map((path) => store.setDir(path, [])))
    for (const path of paths) expect((await store.listDir(path)).entries).toEqual([])
  })

  it('preserves an observed directory token while missing seed tokens initialize', async () => {
    const client = await redis()
    await store.setDir('/existing', [])
    const key = `${prefix}mirage:idx:children:!generation:/existing`
    const multi = client.multi.bind(client)
    const spy = vi.spyOn(client, 'multi').mockImplementationOnce(() => {
      const pipeline = multi()
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = async () => {
        await client.del(key)
        await client.set(key, 'concurrent-replacement')
        return exec()
      }
      return pipeline
    })
    try {
      store.seed(
        new Map(),
        new Map([
          ['/existing', []],
          ['/missing', []],
        ]),
        new Date(Date.now() + 3600000),
      )
      expect((await store.listDir('/existing')).status).toBe(LookupStatus.EXPIRED)
      expect((await store.listDir('/missing')).entries).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['replaced after initialization', 'lost NX'] as const)(
    'keeps pending seed rows expired when their token was %s',
    async (race) => {
      const client = await redis()
      const peer = new RedisIndexCacheStore({ client, keyPrefix: prefix })
      await store.setDir('/other', [])
      const multi = client.multi.bind(client)
      const spy = vi.spyOn(client, 'multi').mockImplementationOnce(() => {
        const pipeline = multi()
        const exec = pipeline.exec.bind(pipeline)
        pipeline.exec = async () => {
          if (race === 'lost NX') {
            await peer.setDir('/snapshot', [['new', entry('new', 'new')]])
          }
          const result = await exec()
          if (race === 'replaced after initialization') {
            await peer.invalidateDir('/snapshot')
            await peer.setDir('/snapshot', [['new', entry('new', 'new')]])
          }
          return result
        }
        return pipeline
      })
      try {
        store.seed(
          new Map([['/snapshot/old', entry('old', 'old')]]),
          new Map([['/snapshot', ['/snapshot/old']]]),
          new Date(Date.now() + 3600000),
        )
        expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
        expect((await store.listDir('/other')).entries).toEqual([])
      } finally {
        spy.mockRestore()
        await peer.close()
      }
    },
  )

  for (const token of ['global', 'directory'] as const) {
    it.each(['replaced after initialization', 'lost NX'] as const)(
      `keeps a scalar refill expired when its ${token} token was %s`,
      async (race) => {
        const client = await redis()
        if (token === 'directory') await store.setDir('/other', [])
        const key = `${prefix}mirage:idx:children:!generation${token === 'directory' ? ':/snapshot' : ''}`
        const set = client.set.bind(client)
        let intercepted = false
        const spy = vi.spyOn(client, 'set').mockImplementation(async (path, value, options) => {
          if (path !== key || intercepted || options?.NX !== true) return set(path, value, options)
          intercepted = true
          if (race === 'lost NX') await set(path, 'concurrent-winner')
          const result = await set(path, value, options)
          if (race === 'replaced after initialization') {
            await client.del(path)
            await set(path, 'concurrent-replacement')
          }
          return result
        })
        try {
          await store.setDir('/snapshot', [['old', entry('old', 'old')]])
          expect(intercepted).toBe(true)
          expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
        } finally {
          spy.mockRestore()
        }
      },
    )
  }

  it('expires year-long listings when an old worker globally invalidates', async () => {
    const deadline = new Date(Date.now() + 365 * 24 * 3600000)
    await store.setDir('/snapshot', [['a', entry('a', 'a')]], deadline)
    await store.setDir('/empty', [], deadline)
    expect((await store.listDir('/snapshot')).entries).toEqual(['/snapshot/a'])
    expect((await store.listDir('/empty')).entries).toEqual([])

    await legacyClear()
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/absent')).status).toBe(LookupStatus.NOT_FOUND)

    await store.setDir('/other', [], deadline)
    expect((await store.listDir('/other')).entries).toEqual([])
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/snapshot', [['b', entry('b', 'b')]], deadline)
    expect((await store.listDir('/snapshot')).entries).toEqual(['/snapshot/b'])
  })

  it('does not revive a refill committed after an old worker clears its generation', async () => {
    await store.setDir('/snapshot', [])
    const client = await redis()
    const multi = client.multi.bind(client)
    const spy = vi.spyOn(client, 'multi').mockImplementationOnce(() => {
      const pipeline = multi()
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = async () => {
        await legacyClear()
        return exec()
      }
      return pipeline
    })
    try {
      await store.setDir('/snapshot', [['old', entry('old', 'old')]])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
      await store.setDir('/other', [])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps a listing expired when its directory token is removed and recreated', async () => {
    const client = await redis()
    const directoryKey = `${prefix}mirage:idx:children:!generation:/snapshot`
    await store.setDir('/snapshot', [])
    const original = await client.get(directoryKey)
    await client.del(directoryKey)
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/other', [])
    expect((await store.listDir('/other')).entries).toEqual([])
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    await client.set(directoryKey, 'replacement-token')
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    await client.del(directoryKey)
    await store.setDir('/snapshot', [])
    expect(await client.get(directoryKey)).not.toBe(original)
    expect((await store.listDir('/snapshot')).entries).toEqual([])
  })

  it('keeps a late refill expired after its directory token is deleted', async () => {
    const client = await redis()
    const directoryKey = `${prefix}mirage:idx:children:!generation:/snapshot`
    await store.setDir('/snapshot', [])
    const multi = client.multi.bind(client)
    const spy = vi.spyOn(client, 'multi').mockImplementationOnce(() => {
      const pipeline = multi()
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = async () => {
        await client.del(directoryKey)
        return exec()
      }
      return pipeline
    })
    try {
      await store.setDir('/snapshot', [['old', entry('old', 'old')]])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
      await store.setDir('/other', [])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['invalidateDir', 'invalidatePrefix', 'clear'] as const)(
    '%s invalidates an independent payload format through stable directory tokens',
    async (method) => {
      const client = await redis()
      const globalKey = `${prefix}mirage:idx:children:!generation`
      const paths = ['/scope', '/scope/nested', '/scope-other']
      const originals = new Map<string, string | null>()
      const foreignKeys: string[] = []
      try {
        for (const path of paths) {
          await store.setDir(path, [])
          originals.set(path, await client.get(`${globalKey}:${path}`))
          const payload = await client.get(`${prefix}mirage:idx:directory:v2:${path}`)
          expect(payload).not.toBeNull()
          const foreignKey = `${prefix}future-index-format:${path}`
          foreignKeys.push(foreignKey)
          await client.set(foreignKey, payload ?? '')
        }
        if (method === 'clear') await store.clear()
        else await store[method]('/scope')

        for (const path of paths) {
          const [payload, global, directory] = await client.mGet([
            `${prefix}future-index-format:${path}`,
            globalKey,
            `${globalKey}:${path}`,
          ])
          expect(payload).not.toBeNull()
          const listing = JSON.parse(payload ?? '') as { generation: string }
          const invalidated =
            method === 'clear' ||
            path === '/scope' ||
            (method === 'invalidatePrefix' && path === '/scope/nested')
          if (invalidated) {
            expect(directory).toBeNull()
            expect(listing.generation).not.toBe(`${global ?? ''}:${directory ?? ''}`)
          } else {
            expect(directory).toBe(originals.get(path))
            expect(listing.generation).toBe(`${global ?? ''}:${directory ?? ''}`)
            expect((await store.listDir(path)).entries).toEqual([])
          }
        }
      } finally {
        await client.del(foreignKeys)
      }
    },
  )

  for (const writerFormat of ['v2', 'v3'] as const) {
    it.each(['invalidate', 'invalidateDir', 'invalidatePrefix', 'clear'] as const)(
      `${writerFormat} %s invalidates a peer using another payload format`,
      async (method) => {
        const peer = new RedisIndexCacheStore({ client: await redis(), keyPrefix: prefix })
        Object.defineProperties(peer, {
          entryPrefix: { value: `${prefix}mirage:idx:entry:v3:` },
          childrenPrefix: { value: `${prefix}mirage:idx:directory:v3:` },
        })
        const writer = writerFormat === 'v2' ? store : peer
        const reader = writerFormat === 'v2' ? peer : store
        const paths = ['/repo', '/repo/sub', '/repository']
        try {
          for (const cache of [store, peer]) {
            for (const path of paths) {
              await cache.setDir(path, [['a', entry('original', 'a')]])
            }
          }
          if (method === 'invalidate' || method === 'clear') await writer[method]()
          else await writer[method]('/repo')

          for (const path of paths) {
            const invalidated =
              method === 'invalidate' ||
              method === 'clear' ||
              path === '/repo' ||
              (method === 'invalidatePrefix' && path === '/repo/sub')
            if (invalidated) {
              expect((await reader.listDir(path)).status).toBe(LookupStatus.EXPIRED)
              await writer.setDir(path, [['b', entry('refreshed', 'b')]])
              expect((await writer.listDir(path)).entries).toEqual([`${path}/b`])
              expect((await reader.listDir(path)).status).toBe(LookupStatus.EXPIRED)
            } else {
              expect((await reader.listDir(path)).entries).toEqual([`${path}/a`])
            }
          }
        } finally {
          await peer.clear()
          await peer.close()
        }
      },
    )
  }

  it('invalidates old workers while retaining current metadata', async () => {
    const client = await redis()
    const legacyEntry = `${prefix}mirage:idx:entry:/snapshot/a`
    const legacyChildren = `${prefix}mirage:idx:children:/snapshot`
    await client.set(legacyEntry, JSON.stringify(entry('old', 'a')))
    await client.rPush(legacyChildren, '/snapshot/a')
    await store.setDir('/snapshot', [['a', entry('new', 'a')]])
    await store.setDir('/empty', [])
    await store.invalidate()

    expect(await client.get(legacyEntry)).toBeNull()
    expect(await client.get(legacyChildren)).toBeNull()
    expect((await store.get('/snapshot/a')).entry?.id).toBe('new')
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/snapshot', [])
    expect((await store.listDir('/snapshot')).entries).toEqual([])
    expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
  })

  it.each(['invalidateDir', 'invalidatePrefix', 'clear'] as const)(
    "%s also removes old workers' cache rows",
    async (method) => {
      const client = await redis()
      const scopedKeys = [
        `${prefix}mirage:idx:entry:/scope/a`,
        `${prefix}mirage:idx:entry:/scope/nested/a`,
      ]
      const other = `${prefix}mirage:idx:entry:/scope-other/a`
      for (const key of [...scopedKeys, other]) {
        await client.set(key, JSON.stringify(entry('old', 'a')))
      }
      const listings = ['/scope', '/scope/nested'].map(
        (path) => `${prefix}mirage:idx:children:${path}`,
      )
      for (const key of listings) await client.rPush(key, '/scope/a')
      if (method === 'clear') await store.clear()
      else await store[method]('/scope')

      for (const key of [...scopedKeys, ...listings]) expect(await client.get(key)).toBeNull()
      if (method === 'clear') expect(await client.get(other)).toBeNull()
      else expect(await client.get(other)).not.toBeNull()
    },
  )

  it('keeps legacy invalidation within literal custom namespaces', async () => {
    const client = await redis()
    const literal = `${prefix}custom:[1]:`
    const neighbor = `${prefix}custom:1:`
    const isolated = new RedisIndexCacheStore({ client, keyPrefix: literal })
    const neighborEntry = `${neighbor}mirage:idx:entry:/a`
    try {
      await client.set(neighborEntry, JSON.stringify(entry('neighbor', 'a')))
      await client.set(`${literal}mirage:idx:entry:/a`, JSON.stringify(entry('old', 'a')))
      await isolated.setDir('/', [['a', entry('new', 'a')]])
      await isolated.invalidate()
      expect(await client.get(`${literal}mirage:idx:entry:/a`)).toBeNull()
      expect(await client.get(neighborEntry)).not.toBeNull()
      expect((await isolated.get('/a')).entry?.id).toBe('new')
      expect((await isolated.listDir('/')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      await isolated.clear()
      await isolated.close()
      await client.del(neighborEntry)
    }
  })

  it('get returns NOT_FOUND when missing', async () => {
    const r = await store.get('/nope')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  for (const invalidate of [false, true]) {
    it.each(['updated', 'renamed', 'deleted'])(
      `warms legacy entries after %s (invalidate=${String(invalidate)})`,
      async (change) => {
        const client = await (
          store as unknown as {
            client: () => Promise<
              RedisClientLike & { rPush: (key: string, value: string) => Promise<number> }
            >
          }
        ).client()
        const key = '/folder/f.txt'
        const entryKey = `${prefix}mirage:idx:entry:${key}`
        const childrenKey = `${prefix}mirage:idx:children:/folder`
        const name = change === 'renamed' ? 'g.txt' : 'f.txt'
        const rows: [string, IndexEntry][] =
          change === 'deleted' ? [] : [[name, entry('new', name)]]
        const warm = vi.fn(() => store.setDir('/folder', rows))
        try {
          await client.set(entryKey, JSON.stringify(entry('old', 'f.txt')))
          await client.rPush(childrenKey, key)
          if (invalidate) await store.invalidate()
          expect((await store.listDir('/folder')).status).toBe(LookupStatus.NOT_FOUND)
          expect((await store.get(key)).status).toBe(LookupStatus.NOT_FOUND)
          expect(await store.entries()).toEqual(new Map())

          const result = await entryOrWarm(store, key, warm)
          if (change === 'updated') expect(result?.id).toBe('new')
          else expect(result).toBeNull()
          expect(warm).toHaveBeenCalledTimes(1)
          expect(await entryOrWarm(store, key, warm)).toEqual(result)
          expect(warm).toHaveBeenCalledTimes(1)
          expect([...(await store.entries()).keys()]).toEqual(
            rows.map(([name]) => `/folder/${name}`),
          )
        } finally {
          await client.del([entryKey, childrenKey])
        }
      },
    )
  }

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
      mGet: vi.fn().mockResolvedValue([null, null, null]),
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
    vi.mocked(value.mGet).mockResolvedValue(['d'])
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
    vi.mocked(value.mGet).mockResolvedValue(['d'])
    const store = new RedisIndexCacheStore({ client: value })
    store.seed(
      new Map([['/a', entry('a', 'a')]]),
      new Map([['/', ['/a']]]),
      new Date(Date.now() + 3600000),
    )
    await Promise.all([store.get('/a'), store.get('/a')])
    expect(pipeline.exec).toHaveBeenCalledTimes(1)
  })

  it('retries a failed initializer shared by parallel directory refills', async () => {
    const { value } = client()
    let rejectRead: (error: Error) => void = () => undefined
    const read = new Promise<string | null>((_resolve, reject) => {
      rejectRead = reject
    })
    vi.mocked(value.get).mockReturnValueOnce(read)
    const store = new RedisIndexCacheStore({ client: value })
    const pending = Promise.allSettled([store.setDir('/one', []), store.setDir('/two', [])])
    await vi.waitFor(() => {
      expect(value.get).toHaveBeenCalledTimes(1)
    })
    rejectRead(new Error('retry'))
    const results = await pending
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(value.get).toHaveBeenCalledTimes(1)
    await expect(store.setDir('/one', [])).resolves.toBeUndefined()
    expect(value.get).toHaveBeenCalledTimes(3)
  })

  it('keeps listings stale when their generation key is evicted', async () => {
    const { value, pipeline } = client()
    const raw = JSON.stringify({ entries: [], expires_at: 4102444800, generation: 'old:dir' })
    vi.mocked(value.mGet).mockResolvedValue([raw, null, 'dir'])
    const store = new RedisIndexCacheStore({ client: value })
    expect((await store.listDir('/old')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/new', [])
    const generation = vi.mocked(value.set).mock.calls[0]?.[1]
    expect(generation).toBeDefined()
    expect(generation).not.toBe('old')
    expect(pipeline.set).toHaveBeenCalled()
    vi.mocked(value.mGet).mockResolvedValue([raw, generation ?? null, 'dir'])
    expect((await store.listDir('/old')).status).toBe(LookupStatus.EXPIRED)
  })

  it('reads a listing and its invalidation generation in one request', async () => {
    const { value } = client()
    vi.mocked(value.mGet).mockResolvedValue([
      JSON.stringify({ entries: [], expires_at: 4102444800, generation: 'g:d' }),
      'g',
      'd',
    ])
    const store = new RedisIndexCacheStore({ client: value })
    expect((await store.listDir('/')).entries).toEqual([])
    expect(value.mGet).toHaveBeenCalledTimes(1)
    expect(value.mGet).toHaveBeenCalledWith([
      'mirage:index:mirage:idx:directory:v2:/',
      'mirage:index:mirage:idx:children:!generation',
      'mirage:index:mirage:idx:children:!generation:/',
    ])
    expect(value.get).not.toHaveBeenCalled()
  })
})
