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

import { CachableAsyncIterator, concat } from '../../io/cachable_iterator.ts'
import { materialize, type IOResult } from '../../io/types.ts'
import type { FileCache } from './mixin.ts'

export async function applyIo(
  cache: FileCache,
  io: IOResult,
  isCacheable?: (path: string) => boolean,
): Promise<void> {
  const cacheSet = new Set(io.cache)
  const maxBytes = cache.maxDrainBytes
  for (const path of io.cache) {
    if (isCacheable !== undefined && !isCacheable(path)) continue
    const source = io.reads[path] ?? io.writes[path]
    if (source === undefined) continue
    if (source instanceof Uint8Array) {
      await cache.set(path, source)
    } else if (source instanceof CachableAsyncIterator) {
      if (source.exhausted) {
        await cache.set(path, concat(source.bufferedChunks))
      } else {
        const tasks = cache.drainTasks
        if (tasks !== undefined && !tasks.has(path) && !(await cache.exists(path))) {
          const task = backgroundDrain(cache, tasks, path, source, maxBytes)
          tasks.set(path, task)
          void task.finally(() => {
            if (tasks.get(path) === task) tasks.delete(path)
          })
        }
      }
    } else {
      const data = await materialize(source)
      await cache.set(path, data)
    }
  }
  for (const path of Object.keys(io.writes)) {
    if (cacheSet.has(path)) continue
    if (isCacheable !== undefined && !isCacheable(path)) continue
    await cache.remove(path)
  }
}

// Drains an unconsumed stream and fills the cache, mirroring the Python
// _background_drain. Promises cannot be cancelled, so remove()/clear()
// delete the map entry and the result is discarded here instead.
async function backgroundDrain(
  cache: FileCache,
  tasks: Map<string, Promise<void>>,
  path: string,
  it: CachableAsyncIterator,
  maxBytes: number | null,
): Promise<void> {
  try {
    let materialized: Uint8Array
    if (maxBytes === null) {
      materialized = await it.drain()
    } else {
      const [data, fullyDrained] = await it.drainBounded(maxBytes)
      if (!fullyDrained) return
      materialized = data
    }
    if (tasks.has(path)) await cache.add(path, materialized)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`background drain failed for ${path}: ${msg}`)
  }
}
