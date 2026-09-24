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

import type { AirtableAccessor } from '../../../../accessor/airtable.ts'
import {
  getRecord,
  listBases,
  listComments,
  listRecords,
  listTables,
} from '../../../../core/airtable/client.ts'
import type { AirtableConfig } from '../../../../core/airtable/config.ts'
import {
  normalizeBase,
  normalizeBaseSummary,
  normalizeComment,
  normalizeTable,
  recordsJsonl,
  toJsonBytes,
} from '../../../../core/airtable/normalize.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { PROG, noOperands, oneOperand, run, scopedBase, usageError } from './util.ts'

function config(inv: CLIInvocation): AirtableConfig {
  return inv.config as AirtableConfig
}

async function baseListBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  _fl: FlagView,
): Promise<CommandFnResult> {
  noOperands(`${PROG} base list`, inv.texts)
  const bases = await listBases(accessor)
  return [toJsonBytes(bases.map(normalizeBaseSummary)), new IOResult()]
}

async function baseGetBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  _fl: FlagView,
): Promise<CommandFnResult> {
  const baseId = scopedBase(config(inv), oneOperand(`${PROG} base get`, inv.texts, 'BASE'))
  for (const base of await listBases(accessor)) {
    if (base.id === baseId) {
      const tables = await listTables(accessor, baseId)
      return [toJsonBytes(normalizeBase(base, tables)), new IOResult()]
    }
  }
  throw new Error(`${baseId}: no such base`)
}

async function tableGetBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
): Promise<CommandFnResult> {
  const ref = oneOperand(`${PROG} table get`, inv.texts, 'TABLE')
  const baseId = scopedBase(config(inv), fl.asStr('base') ?? '')
  const tables = await listTables(accessor, baseId)
  const table = tables.find((t) => t.id === ref) ?? tables.find((t) => t.name === ref)
  if (table === undefined) throw new Error(`${ref}: no such table in ${baseId}`)
  return [toJsonBytes(normalizeTable(table, baseId)), new IOResult()]
}

async function recordListBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
): Promise<CommandFnResult> {
  const prog = `${PROG} record list`
  noOperands(prog, inv.texts)
  const asked = fl.asInt('max_records')
  if (asked !== undefined && asked < 1) throw usageError(prog, '--max-records must be at least 1')
  const baseId = scopedBase(config(inv), fl.asStr('base') ?? '')
  const cap = accessor.maxReadRecords
  const view = fl.asStr('view')
  const formula = fl.asStr('formula')
  const records = await listRecords(accessor, baseId, fl.asStr('table') ?? '', {
    ...(view !== undefined ? { view } : {}),
    ...(formula !== undefined ? { formula } : {}),
    maxRecords: asked ?? cap + 1,
  })
  if (asked === undefined && records.length > cap) {
    throw new Error(
      `more than ${String(cap)} records match (max_read_records); narrow them with --formula ` +
        'or --view, or take the first N with --max-records N',
    )
  }
  return [recordsJsonl(records), new IOResult()]
}

async function recordGetBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
): Promise<CommandFnResult> {
  const recordId = oneOperand(`${PROG} record get`, inv.texts, 'RECORD')
  const baseId = scopedBase(config(inv), fl.asStr('base') ?? '')
  const record = await getRecord(accessor, baseId, fl.asStr('table') ?? '', recordId)
  return [recordsJsonl([record]), new IOResult()]
}

async function commentListBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
): Promise<CommandFnResult> {
  const recordId = oneOperand(`${PROG} comment list`, inv.texts, 'RECORD')
  const baseId = scopedBase(config(inv), fl.asStr('base') ?? '')
  const comments = await listComments(accessor, baseId, fl.asStr('table') ?? '', recordId)
  return [toJsonBytes(comments.map(normalizeComment)), new IOResult()]
}

export const baseList = run(baseListBody)
export const baseGet = run(baseGetBody)
export const tableGet = run(tableGetBody)
export const recordList = run(recordListBody)
export const recordGet = run(recordGetBody)
export const commentList = run(commentListBody)
