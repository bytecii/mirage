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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GitHubAccessor } from '../../accessor/github.ts'
import { PathSpec } from '../../types.ts'
import { lstripSlash, stripSlash } from '../../utils/slash.ts'
import { type GitHubCodeSearch, searchCode } from './client.ts'
import { unsearchableKeys } from './pushdown.ts'

async function search(
  accessor: GitHubAccessor,
  query: string,
  pathFilter?: string,
): Promise<GitHubCodeSearch> {
  return searchCode(accessor.transport, accessor.owner, accessor.repo, query, pathFilter)
}

function stripPrefix(p: PathSpec): string {
  const prefix = mountPrefixOf(p.virtual, p.vfsPath)
  let raw = p.virtual
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  return raw
}

// Returns null whenever the narrowed set cannot be trusted as a superset of
// what a full scan would read (a search failure, or an answer that is not
// the whole set), so the caller falls back to the full scan. A trusted set
// also carries every file code search never indexes, which no answer can
// name.
export async function narrowPaths(
  accessor: GitHubAccessor,
  pattern: string,
  paths: readonly PathSpec[],
): Promise<PathSpec[] | null> {
  const mountPrefix =
    (paths[0] === undefined ? undefined : mountPrefixOf(paths[0].virtual, paths[0].vfsPath)) ?? ''
  const narrowed: string[] = []
  for (const p of paths) {
    const key = stripPrefix(p)
    const pathFilter = stripSlash(key)
    let answer: GitHubCodeSearch
    try {
      answer = await search(accessor, pattern, pathFilter === '' ? undefined : pathFilter)
    } catch {
      // An API failure falls back to the full scan.
      return null
    }
    if (answer.truncated) return null
    const scopePrefix = pathFilter === '' ? '' : `${pathFilter}/`
    const hits = answer.results
      .map((r) => r.path)
      .filter((path) => path === pathFilter || path.startsWith(scopePrefix))
    const seen = new Set(hits)
    narrowed.push(...hits)
    for (const k of unsearchableKeys(accessor.tree, key)) if (!seen.has(k)) narrowed.push(k)
  }
  return narrowed.map(
    (n) =>
      new PathSpec({
        virtual: `${mountPrefix}/${lstripSlash(n)}`,
        directory: '',
        vfsPath: mountKey(`${mountPrefix}/${lstripSlash(n)}`, mountPrefix),
        resolved: true,
      }),
  )
}
