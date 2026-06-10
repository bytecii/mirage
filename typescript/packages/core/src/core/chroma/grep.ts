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

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { compilePattern, grepLines } from '../../commands/builtin/grep_helper.ts'
import { PathSpec } from '../../types.ts'
import { fetchPageChunks, queryContains } from './_client.ts'
import { resolvePath } from './path.ts'
import { walk } from './walk.ts'

const ENC = new TextEncoder()

export interface GrepBytesOptions {
  ignoreCase?: boolean
  invert?: boolean
  lineNumbers?: boolean
  countOnly?: boolean
  filesOnly?: boolean
  wholeWord?: boolean
  fixedString?: boolean
  onlyMatching?: boolean
  maxCount?: number | null
}

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export async function grepBytes(
  accessor: ChromaAccessor,
  paths: readonly PathSpec[],
  pattern: string,
  index?: IndexCacheStore,
  options: GrepBytesOptions = {},
): Promise<[Uint8Array, Record<string, Uint8Array>]> {
  const ignoreCase = options.ignoreCase ?? false
  const invert = options.invert ?? false
  const lineNumbers = options.lineNumbers ?? false
  const countOnly = options.countOnly ?? false
  const filesOnly = options.filesOnly ?? false
  const wholeWord = options.wholeWord ?? false
  const fixedString = options.fixedString ?? false
  const onlyMatching = options.onlyMatching ?? false
  const maxCount = options.maxCount ?? null

  const regex = compilePattern(pattern, ignoreCase, fixedString, wholeWord)
  const targets = await targetSlugs(accessor, paths, index)
  const matchedSlugs = await coarseFilterSlugs(accessor, pattern, targets, {
    ignoreCase,
    invert,
    fixedString,
  })
  const lines: string[] = []
  const reads: Record<string, Uint8Array> = {}
  const slugToPath = new Map<string, string>()
  for (const [path, slug] of targets) {
    slugToPath.set(slug, path)
  }
  for (const slug of matchedSlugs) {
    const content = await fetchPageChunks(accessor, slug)
    const path = slugToPath.get(slug) ?? '/' + slug
    reads[path] = ENC.encode(content)
    const hits = grepLines(path, splitLines(content), regex, {
      invert,
      lineNumbers,
      countOnly,
      filesOnly,
      onlyMatching,
      maxCount,
    })
    if (countOnly) {
      if (hits.length > 0) lines.push(`${path}:${hits[0] ?? ''}`)
    } else if (filesOnly) {
      lines.push(...hits)
    } else {
      lines.push(...hits.map((hit) => `${path}:${hit}`))
    }
  }
  return [ENC.encode(lines.join('\n')), reads]
}

export async function coarseFilterSlugs(
  accessor: ChromaAccessor,
  pattern: string,
  targets: ReadonlyMap<string, string>,
  options: { ignoreCase: boolean; invert: boolean; fixedString: boolean },
): Promise<string[]> {
  const candidateSlugs = [...targets.values()].sort()
  if (options.ignoreCase || options.invert) {
    return candidateSlugs
  }
  return queryContains(accessor, pattern, candidateSlugs, !options.fixedString)
}

export async function targetSlugs(
  accessor: ChromaAccessor,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  for (const path of paths) {
    const resolved = await resolvePath(accessor, path, index)
    if (resolved.entry !== null && !resolved.isDir) {
      targets.set(path.original, String(resolved.entry.extra.slug))
      continue
    }
    if (resolved.isDir) {
      const children = await walk(accessor, path, index, {
        includeRoot: false,
        stripPrefix: false,
      })
      for (const child of children) {
        const childSpec = PathSpec.fromStrPath(child, path.prefix)
        const childResolved = await resolvePath(accessor, childSpec, index)
        if (childResolved.entry !== null && !childResolved.isDir) {
          targets.set(child, String(childResolved.entry.extra.slug))
        }
      }
    }
  }
  return targets
}
