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

import type { PathSpec } from '@struktoai/mirage-core/types'
import { mountedPath } from '@struktoai/mirage-core/utils/key_prefix'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { joinRoot } from './utils.ts'

// The remote search: grep in the C locale, so it compares bytes as mirage
// reads them; --dereference-recursive, so it reads every file the walk can
// reach, a link's target included (GNU's spelling of -R: BSD grep's -R
// follows no link, and refuses this one); and --null, so a name ends where a
// NUL does. `env` sets the locale under any login shell.
export const GREP = 'env LC_ALL=C grep --dereference-recursive -lF --null'

/**
 * The remote grep that lists the files under `scopes` holding `text`.
 * Mirrors Python's `grep_command`.
 */
export function grepCommand(text: string, scopes: string[], ignoreCase: boolean): string {
  const words = [GREP, ...(ignoreCase ? ['-i'] : []), '-e', singleQuote(text)]
  return [...words, '--', ...scopes.map(singleQuote)].join(' ')
}

/**
 * The files under `under` whose bytes hold `text`, as grep on the server
 * finds them.
 *
 * The answer is exact, since every file is searched, so a whole word is asked
 * as plain text: a file the word only sits inside is one more read. Only an
 * exit of 0 or 1 with nothing on stderr answers: a server that runs no
 * commands, a grep that refuses an option (busybox exits 1 for one), or a
 * file it could not read (which the walk then reports) leaves every file to
 * be read. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: SSHAccessor,
  text: string,
  under: PathSpec[],
  ignoreCase: boolean,
): Promise<PathSpec[] | null> {
  const root = accessor.config.root ?? '/'
  const scopes = under.map((p) => joinRoot(root, p.mountPath))
  let status: number | null
  let out: Uint8Array
  let err: Uint8Array
  try {
    ;[status, out, err] = await accessor.run(grepCommand(text, scopes, ignoreCase))
  } catch (error) {
    console.debug(`ssh search left to the scan: ${String(error)}`)
    return null
  }
  if ((status !== 0 && status !== 1) || err.length > 0) return null
  const [first] = under
  if (first === undefined) return []
  const base = root.replace(/\/+$/, '')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const hits: PathSpec[] = []
  let start = 0
  for (let end = out.indexOf(0); end !== -1; end = out.indexOf(0, start)) {
    let name: string
    try {
      name = decoder.decode(out.subarray(start, end))
    } catch {
      return null
    }
    if (!name.startsWith(`${base}/`)) return null
    hits.push(mountedPath(first, name.slice(base.length)))
    start = end + 1
  }
  return hits
}
