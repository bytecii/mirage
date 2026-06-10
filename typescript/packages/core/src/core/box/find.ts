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

import type { BoxAccessor } from '../../accessor/box.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { fnmatch } from '../../util/fnmatch.ts'
import { FileType, PathSpec, type FileStat } from '../../types.ts'
import { rstripSlash } from '../../util/slash.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

interface WalkEntry {
  path: string
  depth: number
  file: boolean
}

async function statEntry(
  accessor: BoxAccessor,
  path: string,
  prefix: string,
  index: IndexCacheStore | undefined,
): Promise<FileStat | null> {
  const spec = new PathSpec({ original: path, directory: path, resolved: false, prefix })
  try {
    return await stat(accessor, spec, index)
  } catch {
    return null
  }
}

async function walk(
  accessor: BoxAccessor,
  spec: PathSpec,
  index: IndexCacheStore | undefined,
  maxDepth: number | null,
  depth: number,
  out: WalkEntry[],
): Promise<void> {
  if (maxDepth !== null && depth > maxDepth) return
  let children: string[]
  try {
    children = await readdir(accessor, spec, index)
  } catch {
    return
  }
  for (const child of children) {
    const slashed = child.endsWith('/')
    const trimmed = slashed ? rstripSlash(child) : child
    let isFolder = slashed
    if (!slashed) {
      // Cached readdir entries carry no trailing slash, so fall back to stat.
      const s = await statEntry(accessor, trimmed, spec.prefix, index)
      isFolder = s !== null && s.type === FileType.DIRECTORY
    }
    out.push({ path: trimmed, depth, file: !isFolder })
    if (isFolder) {
      const childSpec = new PathSpec({
        original: trimmed,
        directory: trimmed,
        resolved: false,
        prefix: spec.prefix,
      })
      await walk(accessor, childSpec, index, maxDepth, depth + 1, out)
    }
  }
}

export async function find(
  accessor: BoxAccessor,
  path: PathSpec,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  const collected: WalkEntry[] = []
  await walk(accessor, path, index, options.maxDepth ?? null, 1, collected)
  const prefix = path.prefix
  const results: string[] = []
  for (const entry of collected.sort((a, b) => a.path.localeCompare(b.path))) {
    const name = entry.path.split('/').pop() ?? ''
    if (options.minDepth != null && entry.depth < options.minDepth) continue
    if (options.type === 'f' && !entry.file) continue
    if (options.type === 'd' && entry.file) continue
    if (options.orNames != null && options.orNames.length > 0) {
      if (!options.orNames.some((pat) => fnmatch(name, pat))) continue
    } else if (options.name != null && !fnmatch(name, options.name)) {
      continue
    }
    if (options.iname != null && !fnmatch(name.toLowerCase(), options.iname.toLowerCase())) {
      continue
    }
    const key =
      prefix !== '' && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
    if (options.pathPattern != null && !fnmatch(key, options.pathPattern)) continue
    if (options.nameExclude != null && fnmatch(name, options.nameExclude)) continue
    const needSize = entry.file && (options.minSize != null || options.maxSize != null)
    const needMtime = options.mtimeMin != null || options.mtimeMax != null
    if (needSize || needMtime) {
      const st = await statEntry(accessor, entry.path, prefix, index)
      if (st === null) continue
      if (needSize) {
        const size = st.size ?? 0
        if (options.minSize != null && size < options.minSize) continue
        if (options.maxSize != null && size > options.maxSize) continue
      }
      if (needMtime) {
        if (st.modified === null || st.modified === '') continue
        const mt = Date.parse(st.modified) / 1000
        if (Number.isNaN(mt)) continue
        if (options.mtimeMin != null && mt < options.mtimeMin) continue
        if (options.mtimeMax != null && mt > options.mtimeMax) continue
      }
    }
    results.push(key)
  }
  return results
}
