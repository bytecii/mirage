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

import type { Accessor } from '../../accessor/base.ts'
import { ResourceType, type IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { entriesUnder, type ReaddirFn } from '../hierarchy/probe.ts'
import { GraphError, graphList } from './client.ts'
import type { MsGraphConfigResolved } from './config.ts'
import type { DriveLoc } from './drive.ts'

function isFolder(entry: IndexEntry): boolean {
  return entry.resourceType === ResourceType.FOLDER
}

/** The Graph `search` function segment for `text`, quoted as an OData string. */
export function searchAction(text: string): string {
  return `/search(q='${encodeURIComponent(text.replaceAll("'", "''"))}')`
}

/**
 * The files under each scope Graph search names. Each scope is walked through
 * the index, the listings grep's own walk reads next, and searched from its
 * folder; a hit is kept when its id is a file the walk found. Null when the
 * search fails, a listed file carries no id, or nothing is found, since Graph
 * indexes a write some time after it lands.
 *
 * Graph searches the text it indexed, not the bytes grep reads, so the answer
 * can leave out a file that holds the text:
 *
 * - an office file, PDF, image or archive, whose raw bytes hold names and
 *   compressed runs its extracted text does not;
 * - a large file, past the part Graph indexes;
 * - a file whose text Graph splits into words differently than grep does
 *   (`foo.bar`, `foo_bar`);
 * - a file changed since Graph last indexed it.
 *
 * Mirrors Python's `files_containing`.
 */
export async function filesContaining<A extends Accessor>(
  config: MsGraphConfigResolved,
  readdir: ReaddirFn<A>,
  accessor: A,
  scopes: readonly (readonly [PathSpec, DriveLoc])[],
  text: string,
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const found: PathSpec[] = []
  for (const [directory, loc] of scopes) {
    const walked = await entriesUnder(readdir, accessor, directory, index, isFolder)
    if (walked === null) return null
    const files = new Map<string, PathSpec[]>()
    for (const [path, entry] of walked) {
      if (isFolder(entry)) continue
      const id = entry.extra.id
      if (typeof id !== 'string' || id === '') return null
      files.set(id, [...(files.get(id) ?? []), path])
    }
    let items: Record<string, unknown>[]
    try {
      items = await graphList(config, loc.item(searchAction(text)), { $select: 'id' })
    } catch (err) {
      // fetch rejects with a TypeError when the connection fails and a
      // DOMException when its timeout aborts it
      if (!(err instanceof GraphError || err instanceof TypeError || err instanceof DOMException)) {
        throw err
      }
      console.warn(`graph search failed (${String(err)}); reading every file`)
      return null
    }
    for (const item of items) {
      if (typeof item.id === 'string') found.push(...(files.get(item.id) ?? []))
    }
  }
  return found.length > 0 ? found : null
}
