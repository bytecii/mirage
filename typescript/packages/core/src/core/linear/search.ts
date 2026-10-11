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

import type { LinearAccessor } from '../../accessor/linear.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { isFsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { recordQueries } from '../../utils/record_search.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { LinearApiError, searchIssues } from './client.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

// The most issues one search answers; a full page may have left some out.
export const SEARCH_LIMIT = 250

// The words an issue's JSON holds whatever its text says: its letter-only key
// names and the JSON literals. Every other field Linear does not search is
// checked against the listing (`unsearchedText`).
export const RECORD_KEYS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'priority',
  'url',
  'true',
  'false',
  'null',
])

// Each issue directory under `scope` by issue id, and the ids whose
// unsearched text holds `text`; null for a scope inside an issue or a listing
// that keeps no unsearched text.
async function issueDirs(
  accessor: LinearAccessor,
  scope: PathSpec,
  index: IndexCacheStore | undefined,
  text: string,
): Promise<[Map<string, PathSpec>, Set<string>] | null> {
  const match = detectScope(scope)
  const base = scope.mountPath.replace(/\/+$/, '')
  let teams: PathSpec[]
  if (match.kind === ROOT || match.kind === 'teams') {
    const root = mountedPath(scope, '/teams')
    teams = (await readdir(accessor, root, index)).map((name) =>
      mountedPath(root, `/teams/${name.split('/').at(-1) ?? name}/issues`),
    )
  } else if (match.kind === 'team') {
    teams = [mountedPath(scope, `${base}/issues`)]
  } else if (match.kind === 'issues') {
    teams = [scope]
  } else if (['members', 'projects', 'cycles', 'documents'].includes(match.kind)) {
    teams = []
  } else {
    return null
  }
  const dirs = new Map<string, PathSpec>()
  const held = new Set<string>()
  for (const issues of teams) {
    const parent = issues.mountPath.replace(/\/+$/, '')
    for (const listed of await readdir(accessor, issues, index)) {
      const child = mountedPath(issues, `${parent}/${listed.split('/').at(-1) ?? listed}`)
      const entry = await resolveEntry(readdir, accessor, child, index)
      const kept = entry?.extra.unsearched
      if (entry === null || typeof kept !== 'string') return null
      dirs.set(entry.id, child)
      if (kept.includes(text.toLowerCase())) held.add(entry.id)
    }
  }
  return [dirs, held]
}

/**
 * The `issue.json` files under `under` whose issue Linear's search names, or
 * whose other fields hold `text`.
 *
 * Linear searches an issue's title and description, so the rest of its JSON
 * (team, project, cycle, state, people, labels, dates, link) is checked
 * against what the listing kept (`unsearchedText`), and the text goes through
 * `recordQueries` for its key names and escapes. Null when the text cannot be
 * searched, a scope lies inside an issue, a search answers a full page or
 * fails, or nothing is found, since Linear indexes a write some time after it
 * lands. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: LinearAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const queries = recordQueries(text, RECORD_KEYS, true)
  if (queries === null) return null
  const found: PathSpec[] = []
  try {
    const named = new Set<string>()
    for (const query of queries) {
      const nodes = await searchIssues(accessor.transport, query, SEARCH_LIMIT)
      if (nodes.length >= SEARCH_LIMIT) return null
      for (const node of nodes) named.add(String(node.id))
    }
    for (const scope of under) {
      const walked = await issueDirs(accessor, scope, index, text)
      if (walked === null) return null
      const [dirs, held] = walked
      for (const [issueId, path] of dirs) {
        if (named.has(issueId) || held.has(issueId)) {
          found.push(mountedPath(path, `${path.mountPath.replace(/\/+$/, '')}/issue.json`))
        }
      }
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it
    const failed =
      isFsError(err) ||
      err instanceof LinearApiError ||
      err instanceof TypeError ||
      err instanceof DOMException
    if (!failed) throw err
    console.warn(`linear search failed (${String(err)}); reading every file`)
    return null
  }
  return found.length > 0 ? found : null
}
