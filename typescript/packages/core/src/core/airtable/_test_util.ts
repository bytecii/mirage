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

import { AirtableAccessor } from '../../accessor/airtable.ts'
import type { AirtableConfig } from './config.ts'

export const API = 'https://api.airtable.com/v0'
export const TOKEN = 'patTest0000000001.secret'
export const ROADMAP = 'appRoadmapBase001'
export const OPS = 'appOpsFinance0001'
export const FEATURES = 'tblFeatures000001'
export const BUDGET = 'tblBudget00000001'
export const GRID = 'viwGrid0000000001'
export const DONE = 'viwDone0000000001'

type Row = Record<string, unknown>

function record(n: number, fields: Row): Row {
  return {
    id: `rec${String(n).padStart(14, '0')}`,
    createdTime: `2026-01-${String(n).padStart(2, '0')}T09:00:00.000Z`,
    fields,
  }
}

function features(): Row[] {
  const rows: Row[] = []
  for (let n = 1; n < 8; n++) {
    const cells: Row = { Name: `Feature ${String(n)}`, Priority: n }
    if (n % 2 === 1) cells.Status = 'Done'
    rows.push(record(n, cells))
  }
  return rows
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function airtableError(status: number, type: string, message?: string): Response {
  return json({ error: message === undefined ? { type } : { type, message } }, status)
}

/**
 * An in-process Airtable API behind a `fetch` seam, paged like the real one:
 * the TypeScript twin of python's tests/fixtures/airtable_api.py, holding
 * the same bases, tables, views and records. `pageCap` keeps pages short so
 * a handful of records still spans several `offset` round trips.
 */
export class FakeAirtable {
  bases: Row[] = [
    { id: ROADMAP, name: 'Product Roadmap', permissionLevel: 'create' },
    { id: OPS, name: 'Ops / Finance ✓', permissionLevel: 'read' },
  ]
  tables: Record<string, Row[]> = {
    [ROADMAP]: [
      {
        id: FEATURES,
        name: 'Features',
        primaryFieldId: 'fldName000000001',
        fields: [
          { id: 'fldName000000001', name: 'Name', type: 'singleLineText' },
          {
            id: 'fldStatus0000001',
            name: 'Status',
            type: 'singleSelect',
            options: { choices: [{ id: 'selDone000000001', name: 'Done' }] },
          },
          {
            id: 'fldPriority00001',
            name: 'Priority',
            type: 'number',
            options: { precision: 0 },
          },
        ],
        views: [
          { id: GRID, name: 'Grid view', type: 'grid' },
          { id: DONE, name: 'Done / shipped', type: 'grid' },
        ],
      },
    ],
    [OPS]: [
      {
        id: BUDGET,
        name: 'Q3 / Budget',
        primaryFieldId: 'fldLine000000001',
        fields: [{ id: 'fldLine000000001', name: 'Line', type: 'singleLineText' }],
        views: [],
      },
    ],
  }
  records: Record<string, Row[]> = {
    [FEATURES]: features(),
    [BUDGET]: [record(1, { Line: 'Rent' })],
  }
  views: Record<string, (row: Row) => boolean> = {
    [GRID]: () => true,
    [DONE]: (row) => (row.fields as Row).Status === 'Done',
  }
  pageCap = 3
  readonly calls: { kind: string; params: Record<string, string> }[] = []

  /** The query of every records request, in order. */
  recordCalls(): Record<string, string>[] {
    return this.calls.filter((c) => c.kind === 'records').map((c) => c.params)
  }

  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const params = Object.fromEntries(url.searchParams.entries())
    const auth = new Headers(init?.headers).get('Authorization')
    const tail = url.pathname.replace(/^\/v0\//, '')
    if (tail === 'meta/bases') {
      this.calls.push({ kind: 'bases', params })
      if (auth !== `Bearer ${TOKEN}`) {
        return Promise.resolve(
          airtableError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required'),
        )
      }
      return Promise.resolve(json({ bases: this.bases }))
    }
    const tables = /^meta\/bases\/([^/]+)\/tables$/.exec(tail)
    if (tables !== null) {
      const baseId = tables[1] ?? ''
      this.calls.push({ kind: 'tables', params: { base: baseId } })
      const schema = this.tables[baseId]
      if (schema === undefined) {
        return Promise.resolve(airtableError(403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND'))
      }
      return Promise.resolve(json({ tables: schema }))
    }
    const [baseId = '', tableId = ''] = tail.split('/')
    this.calls.push({ kind: 'records', params: { ...params, table: tableId } })
    if (!(this.tables[baseId] ?? []).some((t) => t.id === tableId)) {
      return Promise.resolve(airtableError(403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND'))
    }
    let pool = this.records[tableId] ?? []
    if (params.view !== undefined) {
      const keep = this.views[params.view]
      if (keep === undefined) {
        return Promise.resolve(
          airtableError(422, 'VIEW_NAME_NOT_FOUND', `View ${params.view} not found`),
        )
      }
      pool = pool.filter(keep)
    }
    if (params.maxRecords !== undefined) pool = pool.slice(0, Number(params.maxRecords))
    const size = Math.min(Number(params.pageSize ?? '100'), this.pageCap)
    const start = params.offset !== undefined ? Number(params.offset.split('/')[1]) : 0
    const body: Row = { records: pool.slice(start, start + size) }
    if (start + size < pool.length) body.offset = `itrFakeIterator01/${String(start + size)}`
    return Promise.resolve(json(body))
  }
}

/** An accessor against the fake, pacing disabled for speed. */
export function makeAccessor(
  fake: FakeAirtable,
  overrides: Partial<AirtableConfig> = {},
): AirtableAccessor {
  return new AirtableAccessor(
    { token: TOKEN, requestsPerSecond: 10_000, ...overrides },
    { fetchFn: fake.fetch },
  )
}
