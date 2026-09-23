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

import git from 'isomorphic-git'
import { unifiedDiff } from '../../../builtin/diff_format.ts'
import { repoArgs, type Repo } from './repo.ts'
import type { TreeEntry } from './tree.ts'

async function blobData(repo: Repo, entry: TreeEntry | null): Promise<Uint8Array> {
  if (!entry) return new Uint8Array()
  if (entry.mode === '160000') return new TextEncoder().encode(`Subproject commit ${entry.oid}\n`)
  return (await git.readBlob({ ...repoArgs(repo), oid: entry.oid })).blob
}
function lines(data: Uint8Array): string[] {
  const text = new TextDecoder().decode(data)
  return text === '' ? [] : text.split(/(?<=\n)/)
}

export async function filePatch(
  repo: Repo,
  path: string,
  oldPath: string,
  before: TreeEntry | null,
  after: TreeEntry | null,
  score: number | null,
): Promise<string> {
  const a = before,
    b = after,
    name = path,
    origin = oldPath
  const head = [`diff --git a/${origin} b/${name}`]
  if (!a && b) head.push(`new file mode ${b.mode}`)
  else if (!b && a) head.push(`deleted file mode ${a.mode}`)
  else if (a && b && a.mode !== b.mode) head.push(`old mode ${a.mode}`, `new mode ${b.mode}`)
  if (score !== null)
    head.push(`similarity index ${String(score)}%`, `rename from ${origin}`, `rename to ${name}`)
  if (a?.oid === b?.oid) return head.join('\n') + '\n'
  head.push(
    `index ${(a?.oid ?? '0000000').slice(0, 7)}..${(b?.oid ?? '0000000').slice(0, 7)}${a && a.mode === b?.mode ? ' ' + b.mode : ''}`,
  )
  const old = await blobData(repo, a),
    fresh = await blobData(repo, b)
  const from = a ? `a/${origin}` : '/dev/null',
    to = b ? `b/${name}` : '/dev/null'
  if (old.subarray(0, 8000).includes(0) || fresh.subarray(0, 8000).includes(0))
    return head.join('\n') + `\nBinary files ${from} and ${to} differ\n`
  return head.join('\n') + '\n' + unifiedDiff(lines(old), lines(fresh), from, to).join('')
}
