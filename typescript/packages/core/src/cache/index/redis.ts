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

import { underPath } from '../../utils/key_prefix.ts'
import { loadOptionalPeer } from '../../utils/optional_peer.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { IndexEntry, LookupStatus, type ListResult, type LookupResult } from './config.ts'
import { IndexCacheStore } from './store.ts'

const ENTRY_PREFIX = 'mirage:idx:entry:'
const CHILDREN_PREFIX = 'mirage:idx:children:'
const INVALIDATED_KEY = 'mirage:idx:invalidated_at'
const DEFAULT_KEY_PREFIX = 'mirage:index:'
// The least time a listing outlives its own expiry in Redis, in seconds.
export const MIN_EXPIRED_RETENTION = 60

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

/**
 * The JSON a directory listing is stored as.
 *
 * A JSON document rather than a Redis list, because Redis has no empty list:
 * `RPUSH` with no values creates no key, so a directory with no children
 * could never be recorded as listed, every `ls` of it was a cold backend
 * call, and no negative lookup under it was ever absorbed. The two stamps are
 * epoch seconds rather than ISO strings so both languages compare them as
 * numbers; the Python store writes the same three keys (`listing_document`
 * in `cache/index/redis.py`).
 */
export interface ListingDocument {
  children: string[]
  written_at: number
  expires_at: number
}

export function listingDocument(children: string[], writtenAt: number, expiresAt: number): string {
  const doc: ListingDocument = { children, written_at: writtenAt, expires_at: expiresAt }
  return JSON.stringify(doc)
}

/**
 * How long Redis keeps a listing: its freshness plus a retention.
 *
 * Freshness is decided by the caller from the document's own stamps, never
 * by Redis dropping the key, so the key has to outlive its expiry: while it
 * does, a lookup answers EXPIRED exactly as the RAM store does for a stale
 * row it still holds, and only once Redis has forgotten it does the answer
 * become NOT_FOUND. The retention is one more TTL and at least a minute. RAM
 * keeps a stale row until something drops it, but Redis is a shared server
 * and its keyspace needs a bound. Mirrors Python `physical_ttl_seconds`.
 */
export function physicalTtlSeconds(writtenAt: number, expiresAt: number): number {
  const freshFor = Math.max(0, expiresAt - writtenAt)
  return Math.ceil(freshFor + Math.max(freshFor, MIN_EXPIRED_RETENTION))
}

/**
 * The entry JSON on the wire: the shape pydantic writes for the Python
 * `IndexEntry` (snake_case, every field), so one Redis serves both languages.
 * `extra` rides along because it is load-bearing (`size_bytes`,
 * `folder.childCount` that `find -empty` reads on Graph backends).
 */
interface EntryWire {
  id: string
  name: string
  resource_type: string
  remote_time?: string
  index_time?: string
  vfs_name?: string
  size?: number | null
  extra?: Record<string, unknown>
}

function toWire(e: IndexEntry): EntryWire {
  return {
    id: e.id,
    name: e.name,
    resource_type: e.resourceType,
    remote_time: e.remoteTime,
    index_time: e.indexTime,
    vfs_name: e.vfsName,
    size: e.size,
    extra: e.extra,
  }
}

function fromWire(raw: string): IndexEntry {
  const w = JSON.parse(raw) as EntryWire
  return new IndexEntry({
    id: w.id,
    name: w.name,
    resourceType: w.resource_type,
    remoteTime: w.remote_time ?? '',
    indexTime: w.index_time ?? '',
    vfsName: w.vfs_name ?? '',
    size: w.size ?? null,
    extra: w.extra ?? {},
  })
}

interface RedisPipeline {
  set: (key: string, value: string, options?: { EX: number }) => RedisPipeline
  del: (key: string) => RedisPipeline
  exec: () => Promise<unknown>
}

export interface RedisClientLike {
  connect: () => Promise<unknown>
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, options?: { EX: number }) => Promise<unknown>
  mGet: (keys: string[]) => Promise<(string | null)[]>
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

/**
 * Redis-backed index cache for remote resource metadata.
 *
 * Entries are the JSON pydantic writes for the Python `IndexEntry`, and a
 * directory listing is one JSON document (`listingDocument`) carrying the
 * child keys and two epoch-second stamps, `written_at` and `expires_at`.
 * Freshness is decided here, from those stamps, not by Redis dropping the
 * key: the key outlives its expiry (`physicalTtlSeconds`), so a lookup in
 * that window answers EXPIRED as the RAM store does, and `invalidate` writes
 * one `invalidated_at` marker that every listing written before it compares
 * stale against, entries kept. `listDir` is therefore one `MGET` of the
 * listing and the marker.
 *
 * Key layout:
 *
 *     {keyPrefix}mirage:idx:entry:{resourcePath}     -> IndexEntry JSON
 *     {keyPrefix}mirage:idx:children:{resourcePath}  -> listing JSON
 *     {keyPrefix}mirage:idx:invalidated_at           -> epoch seconds
 *
 * Mirrors Python `RedisIndexCacheStore` (`cache/index/redis.py`).
 */
export class RedisIndexCacheStore extends IndexCacheStore {
  private readonly ttl: number
  private readonly url: string
  private readonly providedClient: RedisClientLike | null
  private readonly entryPrefix: string
  private readonly childrenPrefix: string
  private readonly invalidatedKey: string
  private clientPromise: Promise<RedisClientLike> | null = null

  constructor(options: RedisIndexCacheOptions = {}) {
    super()
    this.ttl = options.ttl ?? 600
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.providedClient = options.client ?? null
    const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
    this.entryPrefix = `${prefix}${ENTRY_PREFIX}`
    this.childrenPrefix = `${prefix}${CHILDREN_PREFIX}`
    this.invalidatedKey = `${prefix}${INVALIDATED_KEY}`
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

  private writeListing(
    pipe: RedisPipeline,
    resourcePath: string,
    childKeys: string[],
    writtenAt: number,
    expiresAt: number,
  ): void {
    pipe.set(this.childrenKey(resourcePath), listingDocument(childKeys, writtenAt, expiresAt), {
      EX: physicalTtlSeconds(writtenAt, expiresAt),
    })
  }

  async get(resourcePath: string): Promise<LookupResult> {
    const c = await this.client()
    const raw = await c.get(this.entryKey(resourcePath))
    if (raw === null) return { status: LookupStatus.NOT_FOUND }
    return { entry: fromWire(raw) }
  }

  async put(resourcePath: string, entry: IndexEntry): Promise<void> {
    const c = await this.client()
    const stored =
      entry.indexTime === '' ? entry.copyWith({ indexTime: new Date().toISOString() }) : entry
    await c.set(this.entryKey(resourcePath), JSON.stringify(toWire(stored)))
  }

  async listDir(resourcePath: string): Promise<ListResult> {
    const c = await this.client()
    const [rawListing, rawMarker] = await c.mGet([
      this.childrenKey(resourcePath),
      this.invalidatedKey,
    ])
    if (rawListing === null || rawListing === undefined) return { status: LookupStatus.NOT_FOUND }
    const listing = JSON.parse(rawListing) as ListingDocument
    // Stale when its own expiry has passed, or when `invalidate` ran after
    // it was written; both mirror the RAM store's expiry map.
    if (Date.now() / 1000 > listing.expires_at) return { status: LookupStatus.EXPIRED }
    if (rawMarker !== null && rawMarker !== undefined && Number(rawMarker) >= listing.written_at) {
      return { status: LookupStatus.EXPIRED }
    }
    return { entries: [...listing.children] }
  }

  async setDir(
    resourcePath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    const c = await this.client()
    const now = new Date()
    const nowIso = now.toISOString()
    const prefix = resourcePath === '/' ? '/' : `${resourcePath}/`
    const pipe = c.multi()
    const childKeys: string[] = []
    for (const [name, entry] of entries) {
      const fullPath = prefix + name
      const stored = entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry
      pipe.set(this.entryKey(fullPath), JSON.stringify(toWire(stored)))
      childKeys.push(fullPath)
    }
    const writtenAt = now.getTime() / 1000
    const expiresAt =
      expiredAt !== null && expiredAt !== undefined
        ? expiredAt.getTime() / 1000
        : writtenAt + this.ttl
    this.writeListing(pipe, resourcePath, childKeys, writtenAt, expiresAt)
    await pipe.exec()
  }

  async invalidateDir(resourcePath: string): Promise<void> {
    const c = await this.client()
    const childrenKey = this.childrenKey(resourcePath)
    const raw = await c.get(childrenKey)
    const pipe = c.multi()
    if (raw !== null) {
      for (const child of (JSON.parse(raw) as ListingDocument).children) {
        pipe.del(this.entryKey(child))
      }
    }
    pipe.del(childrenKey)
    await pipe.exec()
  }

  private async scanDelete(prefix: string, resourcePath: string): Promise<void> {
    const c = await this.client()
    const pattern = `${prefix}${globEscape(rstripSlash(resourcePath))}*`
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
    await this.scanDelete(this.entryPrefix, resourcePath)
    await this.scanDelete(this.childrenPrefix, resourcePath)
  }

  /**
   * Mark every listing stale without discarding it.
   *
   * One marker key, `invalidated_at`, rather than a rewrite of every listing:
   * `listDir` reads it beside the listing in the same `MGET` and calls a
   * listing written at or before it EXPIRED. A listing written afterwards is
   * fresh again, and entries are left alone, so `get` keeps answering, which
   * is what the RAM store's in-place expiry gives a backend whose index *is*
   * its listing (github, hf_hub): a refetch instead of an ENOENT.
   */
  async invalidate(): Promise<void> {
    const c = await this.client()
    await c.set(this.invalidatedKey, String(Date.now() / 1000))
  }

  async clear(): Promise<void> {
    const c = await this.client()
    for (const pattern of [`${this.entryPrefix}*`, `${this.childrenPrefix}*`]) {
      const keys: string[] = []
      for await (const k of c.scanIterator({ MATCH: pattern })) {
        if (Array.isArray(k)) keys.push(...k)
        else keys.push(k)
      }
      if (keys.length > 0) await c.del(keys)
    }
    await c.del(this.invalidatedKey)
  }

  override async close(): Promise<void> {
    if (this.providedClient !== null) return
    if (this.clientPromise === null) return
    const c = await this.clientPromise
    const typed = c as unknown as { destroy?: () => void }
    if (typeof typed.destroy === 'function') typed.destroy()
    else if (c.isOpen) await c.quit()
    this.clientPromise = null
  }
}
