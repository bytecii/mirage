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

function monotonicSeconds(): number {
  return performance.now() / 1000
}

function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000)
  })
}

export interface RateLimiterOptions {
  /** Monotonic seconds, injectable for tests. */
  readonly clock?: () => number
  /** The wait, injectable for tests. */
  readonly sleep?: (seconds: number) => Promise<void>
}

/**
 * Spaces calls that share a key to at most `rate` per second.
 *
 * For an API that meters requests per second per resource and answers a
 * burst with a penalty window rather than a queue (Airtable allows 5 per
 * base, then refuses everything for 30 seconds), spacing the calls up front
 * is cheaper than any retry. Each call reserves the next free slot for its
 * key before it awaits anything, so concurrent callers queue in arrival
 * order with no lock.
 */
export class RateLimiter {
  private readonly interval: number
  private readonly clock: () => number
  private readonly sleep: (seconds: number) => Promise<void>
  private readonly next = new Map<string, number>()

  constructor(rate: number, options: RateLimiterOptions = {}) {
    if (!(rate > 0)) throw new RangeError(`rate must be positive, got ${String(rate)}`)
    this.interval = 1 / rate
    this.clock = options.clock ?? monotonicSeconds
    this.sleep = options.sleep ?? sleepSeconds
  }

  /** Wait for this key's next slot (an Airtable base id). */
  async acquire(key: string): Promise<void> {
    const now = this.clock()
    const slot = Math.max(now, this.next.get(key) ?? now)
    this.next.set(key, slot + this.interval)
    if (slot > now) await this.sleep(slot - now)
  }
}
