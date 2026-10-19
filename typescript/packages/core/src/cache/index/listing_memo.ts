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

import type { ListResult } from './config.ts'
import { LISTING_TRUST_WINDOW } from './constants.ts'
import { soleCommandStarted } from './scope.ts'

const WRITES_BY_PREFIX = new Map<string, number>()
const HOLDERS_BY_PREFIX = new Map<string, number>()

function copied(listing: ListResult): ListResult {
  const copy = { ...listing }
  if (copy.entries != null) copy.entries = [...copy.entries]
  if (copy.partialEntries != null) copy.partialEntries = [...copy.partialEntries]
  return copy
}

interface Read {
  readonly writesBefore: number
  readonly readAt: number
  readonly expiresAt: number
  readonly listing: ListResult
}

/**
 * The listings one store read for the running commands.
 *
 * A read is served again only to the command that made it, only while no
 * listing write to the key prefix has finished since the read began, for
 * under LISTING_TRUST_WINDOW seconds, and never past the listing's own
 * expiry. Each fill drops the oldest reads no command can be served any
 * more, so a read stays held for about one window. The key prefix's write
 * count lives while an open memo holds the prefix. On the fallback
 * storage, while more than one command is live, there is no sole stamp and
 * every read goes to Redis.
 */
export class ListingMemo {
  private readonly reads = new Map<string, Read>()
  private closed = false

  constructor(private readonly keyPrefix: string) {
    HOLDERS_BY_PREFIX.set(keyPrefix, (HOLDERS_BY_PREFIX.get(keyPrefix) ?? 0) + 1)
  }

  private written(): number {
    return WRITES_BY_PREFIX.get(this.keyPrefix) ?? 0
  }

  private live(kept: Read): boolean {
    return (
      kept.writesBefore === this.written() &&
      performance.now() - kept.readAt < LISTING_TRUST_WINDOW * 1000 &&
      Date.now() / 1000 < kept.expiresAt
    )
  }

  /**
   * A folder's listing, read from Redis at most once per command.
   *
   * @param folder the listed folder's key.
   * @param fetch reads the listing from Redis and answers it with its
   *   expiry, or with null when there is no live listing to keep.
   */
  async read(
    folder: string,
    fetch: () => Promise<[ListResult, number | null]>,
  ): Promise<ListResult> {
    const stamp = soleCommandStarted()
    if (stamp === null) return (await fetch())[0]
    const key = `${String(stamp)}:${folder}`
    const kept = this.reads.get(key)
    if (kept !== undefined && this.live(kept)) return copied(kept.listing)
    const writes = this.written()
    const readAt = performance.now()
    const [listing, expiresAt] = await fetch()
    if (expiresAt === null || this.written() !== writes || soleCommandStarted() !== stamp) {
      return listing
    }
    for (const [held, read] of this.reads) {
      if (this.live(read)) break
      this.reads.delete(held)
    }
    this.reads.delete(key)
    this.reads.set(key, { writesBefore: writes, readAt, expiresAt, listing })
    return copied(listing)
  }

  /** Runs `fn` and counts a listing write once it is over, whether it threw or not. */
  async writing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } finally {
      this.wrote()
    }
  }

  /** Counts a finished listing write to the key prefix. */
  wrote(): void {
    WRITES_BY_PREFIX.set(this.keyPrefix, this.written() + 1)
  }

  /**
   * Drops the kept listings and releases the key prefix. The last open memo
   * on a prefix drops its write count, so a host that cycles through
   * prefixes keeps none it no longer uses.
   */
  close(): void {
    this.reads.clear()
    if (this.closed) return
    this.closed = true
    const holders = (HOLDERS_BY_PREFIX.get(this.keyPrefix) ?? 0) - 1
    if (holders > 0) {
      HOLDERS_BY_PREFIX.set(this.keyPrefix, holders)
      return
    }
    HOLDERS_BY_PREFIX.delete(this.keyPrefix)
    WRITES_BY_PREFIX.delete(this.keyPrefix)
  }
}
