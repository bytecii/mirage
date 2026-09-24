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

import type { AirtableAccessor } from '../../accessor/airtable.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { efbig, enoent, isEnoent } from '../../utils/errors.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { makeRead, type ReadWindow } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { AirtableApiError, listBases, listRecords, listTables } from './client.ts'
import { normalizeBase, normalizeTable, recordsJsonl, toJsonBytes } from './normalize.ts'
import { readdir, schemaTable } from './readdir.ts'
import { detectScope } from './scope.ts'

/**
 * Refuse a path whose base the mount's `baseIds` excludes. The listing
 * leaves such a base out too, but refusing here answers before any request
 * is made.
 */
export function ensureInScope(accessor: AirtableAccessor, match: ScopeMatch, path: PathSpec): void {
  const wanted = accessor.baseIds
  if (wanted !== null && !wanted.includes(match.slots.base_id ?? '')) throw enoent(path)
}

/**
 * Refuse a path its parent listing does not hold. A reader fetches by the
 * ids in the path, but only the listing proves the names around them.
 * Without this a typed `Wrong__tbl…/table.json` would read under `jq` while
 * `stat` and `cat` call it absent, and a view id from another table would
 * reach the API as a raw 422.
 */
async function ensureListed(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<void> {
  ensureInScope(accessor, match, path)
  const store = index ?? new RAMIndexCacheStore()
  if ((await resolveEntry(readdir, accessor, path, store)) === null) throw enoent(path)
}

async function readBaseJson(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  await ensureListed(accessor, match, path, index)
  const baseId = match.slots.base_id ?? ''
  for (const base of await listBases(accessor)) {
    if (base.id === baseId) {
      return toJsonBytes(normalizeBase(base, await listTables(accessor, baseId)))
    }
  }
  throw enoent(path)
}

async function readTableJson(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  await ensureListed(accessor, match, path, index)
  let table: Record<string, unknown>
  try {
    table = await schemaTable(accessor, match)
  } catch (err) {
    if (isEnoent(err)) throw enoent(path)
    throw err
  }
  return toJsonBytes(normalizeTable(table, match.slots.base_id ?? ''))
}

async function renderRecords(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  view: string | undefined,
  window: ReadWindow,
): Promise<Uint8Array> {
  await ensureListed(accessor, match, path, index)
  const cap = accessor.maxReadRecords
  const skip = window.offset ?? 0
  const limit = window.limit ?? null
  // A window is a record count pushed into maxRecords. One record past the
  // cap proves the full answer would exceed it, without paging through the
  // rest of a large table first.
  const wanted = limit === null ? cap + 1 : Math.min(skip + limit, cap + 1)
  let found: Record<string, unknown>[]
  try {
    found = await listRecords(accessor, match.slots.base_id ?? '', match.slots.table_id ?? '', {
      ...(view !== undefined ? { view } : {}),
      maxRecords: wanted,
    })
  } catch (err) {
    if (err instanceof AirtableApiError && err.notFound) throw enoent(path)
    throw err
  }
  // EFBIG, reported per operand as `<cmd>: <path>: File too large`: the
  // whole file would render more than this mount allows.
  if (found.length > cap) throw efbig(path)
  return recordsJsonl(found.slice(skip))
}

function readRecords(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  window: ReadWindow,
): Promise<Uint8Array> {
  return renderRecords(accessor, match, path, index, undefined, window)
}

function readView(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  window: ReadWindow,
): Promise<Uint8Array> {
  return renderRecords(accessor, match, path, index, match.slots.view_id ?? '', window)
}

export const read = makeRead<AirtableAccessor>(
  detectScope,
  {
    base_json: readBaseJson,
    table_json: readTableJson,
  },
  {
    records: readRecords,
    view: readView,
  },
)
