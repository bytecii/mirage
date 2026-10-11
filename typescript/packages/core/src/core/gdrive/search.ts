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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { GoogleApiError } from '../google/client.ts'
import { searchFiles } from '../google/drive.ts'
import { entriesUnder, resolveEntry } from '../hierarchy/probe.ts'
import { DIRECTORY_RESOURCE_TYPES, readdir } from './readdir.ts'
import { rootContext } from './resolve.ts'

export const PARENTS_PER_QUERY = 40

function isFolder(entry: IndexEntry): boolean {
  return DIRECTORY_RESOURCE_TYPES.has(entry.resourceType)
}

async function folderId(
  accessor: GDriveAccessor,
  directory: PathSpec,
  index?: IndexCacheStore,
): Promise<string | null> {
  if (stripSlash(directory.vfsPath) === '') return (await rootContext(accessor))[0]
  const entry = await resolveEntry(readdir, accessor, directory, index)
  return entry !== null && isFolder(entry) ? entry.id : null
}

/**
 * The files under `under` Drive full-text search names. Each scope is walked
 * through the index, the listings grep's own walk reads next, and Drive is
 * asked which children of the walked folders hold the text. Null when the
 * search fails, Drive reports it did not search every corpus, a scope does
 * not resolve to a folder, or nothing is found, since Drive indexes a write
 * some time after it lands.
 *
 * Drive searches the text it indexed, not the bytes grep reads, so the answer
 * can leave out a file that holds the text:
 *
 * - a Docs, Sheets or Slides file, whose JSON carries keys, style names and
 *   ids Drive does not index;
 * - an office file, PDF, image or archive, whose raw bytes hold names and
 *   compressed runs its extracted text does not;
 * - a large file, past the part Drive indexes;
 * - a file whose text Drive splits into words differently than grep does
 *   (`foo.bar`, `foo_bar`);
 * - a file changed since Drive last indexed it.
 *
 * Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: GDriveAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const found: PathSpec[] = []
  for (const directory of under) {
    const root = await folderId(accessor, directory, index)
    const walked = await entriesUnder(readdir, accessor, directory, index, isFolder)
    if (root === null || walked === null) return null
    const folders = [root]
    const files = new Map<string, PathSpec[]>()
    for (const [path, entry] of walked) {
      if (isFolder(entry)) folders.push(entry.id)
      else files.set(entry.id, [...(files.get(entry.id) ?? []), path])
    }
    for (let start = 0; start < folders.length; start += PARENTS_PER_QUERY) {
      let answer: { ids: string[]; complete: boolean }
      try {
        answer = await searchFiles(
          accessor.tokenManager,
          text,
          folders.slice(start, start + PARENTS_PER_QUERY),
        )
      } catch (err) {
        // fetch rejects with a TypeError when the connection fails and a
        // DOMException when its timeout aborts it
        if (
          !(
            err instanceof GoogleApiError ||
            err instanceof TypeError ||
            err instanceof DOMException
          )
        ) {
          throw err
        }
        console.warn(`drive search failed (${String(err)}); reading every file`)
        return null
      }
      if (!answer.complete) return null
      for (const id of answer.ids) found.push(...(files.get(id) ?? []))
    }
  }
  return found.length > 0 ? found : null
}
