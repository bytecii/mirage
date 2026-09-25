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

import type { GitHubAccessor } from '../../../accessor/github.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { SCOPE_WARN } from '../../../core/github/constants.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { GITHUB_IO } from './io.ts'
import { getExtension } from '../../resolve.ts'
import { BINARY_EXTENSIONS } from '../constants.ts'
import {
  countScopeFiles,
  scopeRelativeKey,
  searchSafe,
  shouldUseSearch,
} from '../../../core/github/pushdown.ts'
import { narrowPaths } from '../../../core/github/search.ts'
import type { PathSpec } from '../../../types.ts'
import { isLiteralPattern, searchQuery } from '../grep_pushdown.ts'

const resolveGlob = resolveGlobOf(GITHUB_IO)

export interface NarrowResult {
  resolved: PathSpec[]
  fileCount: number
  usedSearch: boolean
}

// Resolve grep/rg scope paths, narrowing via GitHub code search. Narrows any
// recursive scope (repo root or subdirectory) on the default branch when a
// literal can be pushed down to code search and the scope is larger than
// SCOPE_WARN; otherwise expands the scope by glob.
//
// Push-down requires -w. GitHub code search matches whole words while grep
// matches substrings, so for a bare literal the search result is a strict
// subset of the grep matches: a file containing the literal only inside a
// longer word (quokka inside quokkabuild) never comes back and would be
// silently dropped from the scan. Under -w both sides mean the same thing,
// and any tokenizer disagreement can only over-fetch, which the local scan
// then filters. A regex narrowed on an extracted literal stays excluded
// even under -w, because the searched term is then only part of the match.
// The refusal for a scope too large to scan without a narrowing. Push-down
// needs -w (see narrowScope), so without it the remedy is -w; with it, code
// search ran and its answer could not be trusted as the whole set, so only a
// narrower path is left.
export function scopeRefusal(command: string, fileCount: number, wholeWord: boolean): string {
  if (wholeWord) {
    return `${command}: ${String(fileCount)} files in scope and code search could not narrow them; narrow the path\n`
  }
  return `${command}: ${String(fileCount)} files in scope, narrow the path, or use -w to enable code search\n`
}

export async function narrowScope(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  pattern: string | null,
  fixedString: boolean,
  recursive: boolean,
  wholeWord: boolean,
  index?: IndexCacheStore,
  exactFileSet = false,
): Promise<NarrowResult> {
  const first = paths[0]
  if (first === undefined) return { resolved: [], fileCount: 0, usedSearch: false }
  const key = scopeRelativeKey(first)
  const fileCount = countScopeFiles(accessor.tree, key)
  const query = pattern !== null ? searchQuery(pattern, fixedString) : null
  // A truncated tree cannot list every file code search skips, so no answer
  // over it can be shown to be the whole set.
  const useSearch =
    !exactFileSet &&
    !accessor.truncated &&
    query !== null &&
    wholeWord &&
    pattern !== null &&
    isLiteralPattern(pattern, fixedString) &&
    searchSafe(query) &&
    shouldUseSearch(recursive, accessor.isDefaultBranch) &&
    fileCount > SCOPE_WARN
  if (useSearch) {
    const narrowed = await narrowPaths(accessor, query, paths)
    if (narrowed !== null && narrowed.length > 0) {
      // A recursive walk skips binary extensions; a narrowing holds only the
      // files that walk would have read.
      const kept = narrowed.filter((p) => !BINARY_EXTENSIONS.has(getExtension(p.virtual) ?? ''))
      return { resolved: kept, fileCount: kept.length, usedSearch: true }
    }
  }
  const resolved = await resolveGlob(accessor, paths, index ?? undefined)
  return { resolved, fileCount, usedSearch: false }
}
