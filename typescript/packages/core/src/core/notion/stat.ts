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

import type { NotionAccessor } from '../../accessor/notion.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { NotionAPIError } from './client.ts'
import { pageSegmentName } from './normalize.ts'
import { getPage } from './pages.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

function pageStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    modified: entry.remoteTime !== '' ? entry.remoteTime : null,
    extra: { page_id: entry.id },
  })
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// No listing names a row, so the row answers for itself: it exists when the
// page does, sits in this data source, is not in the trash, and the path
// spells it as rows.jsonl does.
async function rowStat(
  accessor: NotionAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<FileStat> {
  const name = stripSlash(path.vfsPath).split('/').pop() ?? ''
  let page: Record<string, unknown>
  try {
    page = await getPage(accessor.transport, match.slots.page_id ?? '')
  } catch (err) {
    if (err instanceof NotionAPIError && (err.status === 404 || err.code === 'validation_error')) {
      throw enoent(path.virtual)
    }
    throw err
  }
  const parent = asObject(page.parent)
  if (
    parent.data_source_id !== match.slots.data_source_id ||
    page.in_trash === true ||
    page.archived === true ||
    pageSegmentName(page) !== name
  ) {
    throw enoent(path.virtual)
  }
  const edited = typeof page.last_edited_time === 'string' ? page.last_edited_time : ''
  return new FileStat({
    name,
    type: FileType.DIRECTORY,
    modified: edited !== '' ? edited : null,
    extra: { page_id: typeof page.id === 'string' ? page.id : '' },
  })
}

function pageJsonStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
  })
}

function databaseStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    modified: entry.remoteTime !== '' ? entry.remoteTime : null,
    extra: { database_id: entry.id },
  })
}

function databaseJsonStat(match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
    extra: { database_id: match.slots.database_id ?? '' },
  })
}

function dataSourceStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    modified: entry.remoteTime !== '' ? entry.remoteTime : null,
    extra: { data_source_id: entry.id },
  })
}

function dataSourceJsonStat(match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
    extra: { data_source_id: match.slots.data_source_id ?? '' },
  })
}

function rowsJsonlStat(match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.TEXT,
    size: entry.size,
    extra: { data_source_id: match.slots.data_source_id ?? '' },
  })
}

export const stat = makeStat(detectScope, readdir, {
  overrides: { row: rowStat },
  entryStats: {
    page: pageStat,
    page_json: pageJsonStat,
    row_json: pageJsonStat,
    database: databaseStat,
    database_json: databaseJsonStat,
    data_source: dataSourceStat,
    data_source_json: dataSourceJsonStat,
    rows_jsonl: rowsJsonlStat,
  },
})
