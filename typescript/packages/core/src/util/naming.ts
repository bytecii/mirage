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

import { pathSafeName, sanitizeName } from './sanitize.ts'

/**
 * Build a `<name>__<id>` segment for VFS paths.
 *
 * Used by resources that encode resource IDs in filenames for reverse lookups
 * (Discord, Slack, Linear, Trello). By default applies the full
 * `sanitizeName` transform; set `pathSafe` to preserve the original spelling
 * and only escape the path separator. Discord and Slack use `pathSafe` so
 * display names stay readable.
 */
export function makeIdName(displayName: string, resourceId: string, pathSafe = false): string {
  const transform = pathSafe ? pathSafeName : sanitizeName
  return `${transform(displayName)}__${resourceId}`
}

/**
 * Extract `[displayName, resourceId]` from `makeIdName` output, optionally
 * stripping a file extension first. Throws when `name` doesn't end with
 * `suffix` or doesn't contain `__`.
 */
export function parseIdName(name: string, suffix = ''): [string, string] {
  if (suffix !== '' && !name.endsWith(suffix)) {
    throw new Error(`ENOENT: ${name}`)
  }
  const raw = suffix !== '' ? name.slice(0, -suffix.length) : name
  const idx = raw.lastIndexOf('__')
  if (idx === -1) {
    throw new Error(`ENOENT: ${name}`)
  }
  const label = raw.slice(0, idx)
  const id = raw.slice(idx + 2)
  if (id === '') {
    throw new Error(`ENOENT: ${name}`)
  }
  return [label, id]
}
