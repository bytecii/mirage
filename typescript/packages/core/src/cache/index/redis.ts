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

import { toIsoZ } from '../../utils/dates.ts'
import { KeyLock } from '../lock.ts'
import { uuid7 } from '../../utils/ids.ts'
import { underPath } from '../../utils/key_prefix.ts'
import { loadOptionalPeer } from '../../utils/optional_peer.ts'
import { rstripSlash } from '../../utils/slash.ts'
import {
  IndexEntry,
  LookupStatus,
  type IndexDirectory,
  type IndexEntryInit,
  type ListResult,
  type LookupResult,
} from './config.ts'
import { IndexCacheStore } from './store.ts'

const ENTRY_PREFIX = 'mirage:idx:entry:'
const CHILDREN_PREFIX = 'mirage:idx:directory:v2:'
const DEFAULT_KEY_PREFIX = 'mirage:index:'

/**
 * Escape redis MATCH metacharacters in a literal path.
 *
 * A path may legally contain `*?[]`, and SCAN's pattern is a glob, so an
 * unescaped path would match keys it does not name. The escaping is a
 * narrowing optimization only; the caller still filters at a path boundary.
 * Mirrors Python `_glob_escape` (`cache/index/redis.py`).
 */
function globEscape(value: string): string {
  return value.replace(/[*?[\]\\]/g, (char) => `\\${char}`)
}

interface RedisPipeline {
  set: (key: string, value: string) => RedisPipeline
  del: (key: string) => RedisPipeline
  exec: () => Promise<unknown>
}

export interface RedisClientLike {
  connect: () => Promise<unknown>
  get: (key: string) => Promise<string | null>
  mGet: (keys: string[]) => Promise<(string | null)[]>
  set: (key: string, value: string, options?: { NX: boolean }) => Promise<unknown>
  del: (key: string | string[]) => Promise<unknown>
  multi: () => RedisPipeline
  scanIterator: (options: { MATCH: string }) => AsyncIterable<string | string[]>
  isOpen: boolean
  quit: () => Promise<unknown>
}

export interface RedisIndexCacheOptions {
  ttl?: number
  url?: string
  client?: RedisClientLike
  keyPrefix?: string
}

// Directory records retain stale listings like RAM; Redis maxmemory eviction
// can still turn any cached fact into a miss. v2 avoids reading legacy lists as JSON.
export class RedisIndexCacheStore extends IndexCacheStore {
  private readonly ttl: number
  private readonly url: string
  private readonly providedClient: RedisClientLike | null
  private readonly entryPrefix: string
  private readonly childrenPrefix: string
  private readonly generationKey: string
  private clientPromise: Promise<RedisClientLike> | null = null

  private readonly seedLock = new KeyLock()
  private readonly pendingSeeds: {
    entries: Map<string, IndexEntry>
    children: Map<string, string[]>
    expiresAt: number
  }[] = []
  private closed = false

  constructor(options: RedisIndexCacheOptions = {}) {
    super()
    this.ttl = options.ttl ?? 600
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.providedClient = options.client ?? null
    const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
    this.entryPrefix = `${prefix}${ENTRY_PREFIX}`
    this.childrenPrefix = `${prefix}${CHILDREN_PREFIX}`
    this.generationKey = `${prefix}mirage:idx:generation`
  }

  private entryKey(path: string): string {
    return `${this.entryPrefix}${path}`
  }

  private childrenKey(path: string): string {
    return `${this.childrenPrefix}${path}`
  }

  private client(): Promise<RedisClientLike> {
    if (this.providedClient !== null) return Promise.resolve(this.providedClient)
    this.clientPromise ??= (async () => {
      const spec = 'redis'
      const mod = (await loadOptionalPeer(() => import(/* @vite-ignore */ spec), {
        feature: 'RedisIndexCacheStore',
        packageName: 'redis',
      })) as {
        createClient: (o: { url: string; socket?: unknown }) => RedisClientLike
      }
      const c = mod.createClient({
        url: this.url,
        socket: { reconnectStrategy: false },
      })
      await c.connect()
      return c
    })()
    return this.clientPromise
  }

  seed(
    entries: ReadonlyMap<string, IndexEntry>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
  ): void {
    const nowIso = toIsoZ(new Date())
    this.pendingSeeds.push({
      entries: new Map(
        [...entries].map(([path, entry]) => [
          path,
          entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry,
        ]),
      ),
      children: new Map([...children].map(([path, keys]) => [path, [...keys]])),
      expiresAt: expiresAt.getTime() / 1000,
    })
  }

  private async generation(c: RedisClientLike): Promise<string> {
    const current = await c.get(this.generationKey)
    if (current !== null) return current
    // A new token after eviction must never revive an old listing.
    const generation = uuid7()
    await c.set(this.generationKey, generation, { NX: true })
    return (await c.get(this.generationKey)) ?? generation
  }

  private flushSeed(): Promise<void> {
    return this.seedLock.withLock('seed', async () => {
      while (this.pendingSeeds.length > 0) {
        const pending = [...this.pendingSeeds]
        const c = await this.client()
        const generation = await this.generation(c)
        const pipe = c.multi()
        for (const seed of pending) {
          for (const [path, entry] of seed.entries) {
            pipe.set(this.entryKey(path), JSON.stringify(this.serialize(entry)))
          }
          for (const [path, keys] of seed.children) {
            const listing: IndexDirectory = {
              entries: keys,
              expires_at: seed.expiresAt,
              generation,
            }
            pipe.set(this.childrenKey(path), JSON.stringify(listing))
          }
        }
        await pipe.exec()
        this.pendingSeeds.splice(0, pending.length)
      }
    })
  }

  async entries(): Promise<Map<string, IndexEntry>> {
    await this.flushSeed()
    const c = await this.client()
    const entries = new Map<string, IndexEntry>()
    for await (const batch of c.scanIterator({ MATCH: `${globEscape(this.entryPrefix)}*` })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) {
        const raw = await c.get(key)
        if (raw !== null)
          entries.set(
            key.slice(this.entryPrefix.length),
            new IndexEntry(JSON.parse(raw) as IndexEntryInit),
          )
      }
    }
    return entries
  }

  async get(resourcePath: string): Promise<LookupResult> {
    await this.flushSeed()
    const c = await this.client()
    const raw = await c.get(this.entryKey(resourcePath))
    if (raw === null) return { status: LookupStatus.NOT_FOUND }
    const parsed = JSON.parse(raw) as IndexEntryInit
    return { entry: new IndexEntry(parsed) }
  }

  async put(resourcePath: string, entry: IndexEntry): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    const stored =
      entry.indexTime === '' ? entry.copyWith({ indexTime: toIsoZ(new Date()) }) : entry
    await c.set(this.entryKey(resourcePath), JSON.stringify(this.serialize(stored)))
  }

  async listDir(resourcePath: string): Promise<ListResult> {
    await this.flushSeed()
    const c = await this.client()
    const [raw, current] = await c.mGet([this.childrenKey(resourcePath), this.generationKey])
    if (raw == null) return { status: LookupStatus.NOT_FOUND }
    const listing = JSON.parse(raw) as IndexDirectory
    if (listing.generation !== current || Date.now() / 1000 >= listing.expires_at)
      return { status: LookupStatus.EXPIRED }
    return { entries: listing.entries }
  }

  async setDir(
    resourcePath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    const now = new Date()
    const nowIso = toIsoZ(now)
    const prefix = resourcePath === '/' ? '/' : `${resourcePath}/`
    const generation = await this.generation(c)
    const pipe = c.multi()
    const childKeys: string[] = []
    for (const [name, entry] of entries) {
      const fullPath = prefix + name
      const stored = entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry
      pipe.set(this.entryKey(fullPath), JSON.stringify(this.serialize(stored)))
      childKeys.push(fullPath)
    }
    const listing: IndexDirectory = {
      entries: childKeys,
      generation,
      expires_at: (expiredAt?.getTime() ?? now.getTime() + this.ttl * 1000) / 1000,
    }
    pipe.set(this.childrenKey(resourcePath), JSON.stringify(listing))
    await pipe.exec()
  }

  async invalidateDir(resourcePath: string): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    const raw = await c.get(this.childrenKey(resourcePath))
    const childPaths = raw === null ? [] : (JSON.parse(raw) as IndexDirectory).entries
    const pipe = c.multi()
    for (const child of childPaths) {
      pipe.del(this.entryKey(child))
    }
    pipe.del(this.childrenKey(resourcePath))
    await pipe.exec()
  }

  private async scanDelete(prefix: string, resourcePath: string): Promise<void> {
    const c = await this.client()
    const pattern = `${globEscape(prefix + rstripSlash(resourcePath))}*`
    const keys: string[] = []
    for await (const k of c.scanIterator({ MATCH: pattern })) {
      const batch = Array.isArray(k) ? k : [k]
      for (const key of batch) {
        if (underPath(key.slice(prefix.length), resourcePath)) keys.push(key)
      }
    }
    if (keys.length > 0) await c.del(keys)
  }

  async invalidatePrefix(resourcePath: string): Promise<void> {
    await this.flushSeed()
    await this.scanDelete(this.entryPrefix, resourcePath)
    await this.scanDelete(this.childrenPrefix, resourcePath)
  }

  async invalidate(): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    // Atomically expire listings without overwriting concurrent refills/deletions.
    await c.set(this.generationKey, uuid7())
  }

  clear(): Promise<void> {
    return this.seedLock.withLock('seed', async () => {
      this.pendingSeeds.length = 0
      await this.scanDelete(this.entryPrefix, '/')
      await this.scanDelete(this.childrenPrefix, '/')
      const c = await this.client()
      await c.del(this.generationKey)
    })
  }

  override async close(): Promise<void> {
    if (this.closed) return
    await this.flushSeed()
    if (this.providedClient === null && this.clientPromise !== null) {
      const c = await this.clientPromise
      const typed = c as unknown as { destroy?: () => void }
      if (typeof typed.destroy === 'function') typed.destroy()
      else if (c.isOpen) await c.quit()
      this.clientPromise = null
    }
    this.closed = true
  }

  private serialize(e: IndexEntry): Record<string, unknown> {
    return {
      id: e.id,
      name: e.name,
      resourceType: e.resourceType,
      remoteTime: e.remoteTime,
      indexTime: e.indexTime,
      vfsName: e.vfsName,
      size: e.size,
      extra: e.extra,
    }
  }
}
