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
  createComment,
  createRecords,
  deleteRecords,
  listTables,
  updateRecords,
} from '../../../../core/airtable/client.ts'
import type { AirtableConfig } from '../../../../core/airtable/config.ts'
import {
  deletionsJsonl,
  normalizeComment,
  recordsJsonl,
  toJsonBytes,
} from '../../../../core/airtable/normalize.ts'
import { IOResult } from '../../../../io/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  PROG,
  jsonObject,
  noOperands,
  oneOperand,
  optionalOperand,
  run,
  scopedBase,
  stdinText,
  usageError,
} from './util.ts'

type Row = Record<string, unknown>

const ENC = new TextEncoder()

const LINE_KEYS: ReadonlySet<string> = new Set(['record_id', 'created_time', 'fields'])

// The field types Airtable computes and refuses a write to. A mount line
// carries every one of them, so a line piped back drops them first.
const COMPUTED_TYPES: ReadonlySet<string> = new Set([
  'aiText',
  'autoNumber',
  'button',
  'count',
  'createdBy',
  'createdTime',
  'externalSyncSource',
  'formula',
  'lastModifiedBy',
  'lastModifiedTime',
  'lookup',
  'multipleLookupValues',
  'rollup',
])

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function config(inv: CLIInvocation): AirtableConfig {
  return inv.config as AirtableConfig
}

/**
 * Stdin's JSONL, one normalized record per line, validated whole. A line is
 * the shape records.jsonl holds, so a mount read piped through jq
 * round-trips. Every line is checked before anything is sent: a bad line 15
 * must not leave ten records already written. A blank line is skipped but
 * still counted, so a refusal names the line an editor shows.
 */
function recordLines(prog: string, text: string, need: { id: boolean; fields: boolean }): Row[] {
  const rows: Row[] = []
  text.split('\n').forEach((line, index) => {
    if (/^[ \t\r]*$/.test(line)) return
    const where = `stdin line ${String(index + 1)}`
    let row: unknown
    try {
      row = JSON.parse(line) as unknown
    } catch {
      throw usageError(prog, `${where}: not valid JSON`)
    }
    if (!isRow(row)) throw usageError(prog, `${where}: not a JSON object`)
    const unknown = Object.keys(row)
      .filter((key) => !LINE_KEYS.has(key))
      .sort(compareCodePoints)[0]
    if (unknown !== undefined) {
      throw usageError(prog, `${where}: unknown key ${JSON.stringify(unknown)}`)
    }
    if ('fields' in row && !isRow(row.fields)) {
      throw usageError(prog, `${where}: "fields" must be an object`)
    }
    if (need.id && !('record_id' in row)) {
      throw usageError(prog, `${where}: "record_id" is required`)
    }
    if (need.id && typeof row.record_id !== 'string') {
      throw usageError(prog, `${where}: "record_id" must be a string`)
    }
    if (need.fields && !('fields' in row)) {
      throw usageError(prog, `${where}: "fields" is required`)
    }
    rows.push(row)
  })
  return rows
}

/** The cells with every computed field of the table taken out. */
async function writable(
  accessor: AirtableAccessor,
  baseId: string,
  table: string,
  cells: Row[],
): Promise<Row[]> {
  const tables = await listTables(accessor, baseId)
  const found = tables.find((t) => t.id === table) ?? tables.find((t) => t.name === table)
  const fields = Array.isArray(found?.fields) ? (found.fields as unknown[]).filter(isRow) : []
  const computed = new Set(
    fields.filter((f) => COMPUTED_TYPES.has(String(f.type))).map((f) => f.name),
  )
  return cells.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !computed.has(k))))
}

/**
 * Everything the batches wrote, and the failure that stopped them. Batches
 * land one request at a time, so a failure part way leaves the earlier ones
 * written. They are printed anyway, with the error on stderr and exit 1, so
 * the line shows what reached the base. A failure before anything landed
 * throws, for the executor to render in the same `<prog>: <error>` shape.
 */
async function landed(
  prog: string,
  batches: AsyncIterable<Row[]>,
  render: (rows: Row[]) => Uint8Array,
): Promise<CommandFnResult> {
  const done: Row[] = []
  try {
    for await (const batch of batches) done.push(...batch)
  } catch (err) {
    if (done.length === 0) throw err
    const message = err instanceof Error ? err.message : String(err)
    return [
      render(done),
      new IOResult({ exitCode: 1, stderr: ENC.encode(`${prog}: ${message}\n`) }),
    ]
  }
  return [render(done), new IOResult()]
}

async function recordCreateBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
): Promise<CommandFnResult> {
  const prog = `${PROG} record create`
  noOperands(prog, inv.texts)
  const fields = fl.asStr('fields')
  const table = fl.asStr('table') ?? ''
  let cells: Row[]
  let piped = false
  if (fields !== undefined) {
    cells = [jsonObject(prog, '--fields', fields)]
  } else if (inv.stdin !== null) {
    const rows = recordLines(prog, await stdinText(inv.stdin), { id: false, fields: true })
    cells = rows.map((row) => row.fields as Row)
    piped = rows.length > 0
  } else {
    throw usageError(prog, '--fields or records on stdin are required')
  }
  const baseId = scopedBase(config(inv), fl.asStr('base') ?? '')
  if (piped) cells = await writable(accessor, baseId, table, cells)
  const batches = createRecords(accessor, baseId, table, cells, {
    typecast: fl.asBool('typecast'),
  })
  return landed(prog, batches, recordsJsonl)
}

async function recordUpdateBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
): Promise<CommandFnResult> {
  const prog = `${PROG} record update`
  const recordId = optionalOperand(prog, inv.texts)
  const fields = fl.asStr('fields')
  const table = fl.asStr('table') ?? ''
  if (recordId !== null && fields === undefined) {
    throw usageError(prog, '--fields is required with RECORD')
  }
  if (recordId === null && fields !== undefined) {
    throw usageError(prog, 'RECORD is required with --fields')
  }
  let ids: string[]
  let cells: Row[]
  let piped = false
  if (recordId !== null && fields !== undefined) {
    ids = [recordId]
    cells = [jsonObject(prog, '--fields', fields)]
  } else if (inv.stdin !== null) {
    const rows = recordLines(prog, await stdinText(inv.stdin), { id: true, fields: true })
    ids = rows.map((row) => String(row.record_id))
    cells = rows.map((row) => row.fields as Row)
    piped = rows.length > 0
  } else {
    throw usageError(prog, 'RECORD --fields or records on stdin are required')
  }
  const baseId = scopedBase(config(inv), fl.asStr('base') ?? '')
  if (piped) cells = await writable(accessor, baseId, table, cells)
  const updates = ids.map((id, i): [string, Row] => [id, cells[i] ?? {}])
  const batches = updateRecords(accessor, baseId, table, updates, {
    typecast: fl.asBool('typecast'),
  })
  return landed(prog, batches, recordsJsonl)
}

async function recordDeleteBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
): Promise<CommandFnResult> {
  const prog = `${PROG} record delete`
  let recordIds: string[]
  if (inv.texts.length > 0) {
    recordIds = [...inv.texts]
  } else if (inv.stdin !== null) {
    const rows = recordLines(prog, await stdinText(inv.stdin), { id: true, fields: false })
    recordIds = rows.map((row) => String(row.record_id))
  } else {
    throw usageError(prog, 'RECORD or records on stdin are required')
  }
  const baseId = scopedBase(config(inv), fl.asStr('base') ?? '')
  const batches = deleteRecords(accessor, baseId, fl.asStr('table') ?? '', recordIds)
  return landed(prog, batches, deletionsJsonl)
}

async function commentAddBody(
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
): Promise<CommandFnResult> {
  const prog = `${PROG} comment add`
  const recordId = oneOperand(prog, inv.texts, 'RECORD')
  let text = fl.asStr('text')
  if (text === undefined) {
    if (inv.stdin === null) throw usageError(prog, '--text or text on stdin is required')
    const piped = await stdinText(inv.stdin)
    text = piped.endsWith('\n') ? piped.slice(0, -1) : piped
  }
  if (text === '') throw usageError(prog, 'the comment text is empty')
  const baseId = scopedBase(config(inv), fl.asStr('base') ?? '')
  const comment = await createComment(accessor, baseId, fl.asStr('table') ?? '', recordId, text)
  return [toJsonBytes(normalizeComment(comment)), new IOResult()]
}

export const recordCreate = run(recordCreateBody)
export const recordUpdate = run(recordUpdateBody)
export const recordDelete = run(recordDeleteBody)
export const commentAdd = run(commentAddBody)
