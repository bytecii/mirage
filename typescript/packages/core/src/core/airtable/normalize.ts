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

import { jsonBytes, jsonlBytes } from '../render/json.ts'

type Row = Record<string, unknown>

function asRows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((v): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v))
    : []
}

function field(row: Row, key: string): unknown {
  return row[key] ?? null
}

/** base.json: the base and the tables it holds. */
export function normalizeBase(base: Row, tables: readonly Row[]): Row {
  return {
    base_id: field(base, 'id'),
    base_name: field(base, 'name'),
    permission_level: field(base, 'permissionLevel'),
    tables: tables.map((table) => ({
      table_id: field(table, 'id'),
      table_name: field(table, 'name'),
      primary_field_id: field(table, 'primaryFieldId'),
    })),
  }
}

/** One column: its id, name, type and the type's options. */
export function normalizeField(column: Row): Row {
  return {
    field_id: field(column, 'id'),
    field_name: field(column, 'name'),
    type: field(column, 'type'),
    description: field(column, 'description'),
    options: field(column, 'options'),
  }
}

/** One saved view: its id, name and kind (grid, kanban, ...). */
export function normalizeView(view: Row): Row {
  return {
    view_id: field(view, 'id'),
    view_name: field(view, 'name'),
    type: field(view, 'type'),
  }
}

/** table.json: the column schema and the saved views. */
export function normalizeTable(table: Row, baseId: string): Row {
  return {
    table_id: field(table, 'id'),
    table_name: field(table, 'name'),
    base_id: baseId,
    description: field(table, 'description'),
    primary_field_id: field(table, 'primaryFieldId'),
    fields: asRows(table.fields).map(normalizeField),
    views: asRows(table.views).map(normalizeView),
  }
}

/**
 * One records.jsonl row. `fields` is Airtable's cell map, keyed by field
 * name and passed through untouched: an empty cell is absent (Airtable never
 * sends one), a link is a list of record ids, and an attachment's url is the
 * API's own, which expires two hours after it was fetched.
 */
export function normalizeRecord(record: Row): Row {
  const cells = record.fields
  return {
    record_id: field(record, 'id'),
    created_time: field(record, 'createdTime'),
    fields: typeof cells === 'object' && cells !== null && !Array.isArray(cells) ? cells : {},
  }
}

/** Render a .json leaf. */
export function toJsonBytes(value: unknown): Uint8Array {
  return jsonBytes(value)
}

/** Render records one per line, in the order they were listed. */
export function recordsJsonl(listed: readonly Row[]): Uint8Array {
  return jsonlBytes(listed.map(normalizeRecord))
}
