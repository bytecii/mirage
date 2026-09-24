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
import type { ErrorOf } from '../../types.ts'
import { apiRequest, type RetryPolicy } from '../api/client.ts'
import { cursorItems, offsetCursor, type PageShape } from '../api/paginate.ts'

export const PAGE_SIZE = 100

// Metadata calls (the base listing) are metered per account rather than per
// base; they pace under their own key.
export const META_KEY = 'meta'

const NOT_FOUND_TYPES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'MODEL_ID_NOT_FOUND',
  'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND',
])

// Airtable takes at most ten records in one create, update or delete.
export const MAX_BATCH = 10

export const BASES: PageShape = { itemsKey: 'bases', nextCursor: offsetCursor }
export const RECORDS: PageShape = { itemsKey: 'records', nextCursor: offsetCursor }
export const COMMENTS: PageShape = { itemsKey: 'comments', nextCursor: offsetCursor }

/** A >= 400 answer from the Airtable API, with its status and error type. */
export class AirtableApiError extends Error {
  readonly status: number | null
  readonly errorType: string | null

  constructor(message: string, status: number | null = null, errorType: string | null = null) {
    super(message)
    this.name = 'AirtableApiError'
    this.status = status
    this.errorType = errorType
  }

  /**
   * Whether the call named something the token cannot see. Airtable
   * answers a well-formed id it cannot resolve with a 403, not a 404: the
   * permission and the existence checks share one answer so a token cannot
   * probe for bases it was not granted.
   */
  get notFound(): boolean {
    return this.status === 404 || (this.errorType !== null && NOT_FOUND_TYPES.has(this.errorType))
  }
}

/**
 * Airtable's error type and message, from any of its body shapes:
 * `{"error": {"type", "message"}}`, the same object without a message, or a
 * bare `{"error": "NOT_FOUND"}` for an unmatched route or a malformed id.
 */
export function errorParts(text: string): [string | null, string | null] {
  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch {
    return [null, null]
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [null, null]
  const error = (data as { error?: unknown }).error
  if (typeof error === 'string') return [error, null]
  if (typeof error === 'object' && error !== null) {
    const { type, message } = error as { type?: unknown; message?: unknown }
    return [typeof type === 'string' ? type : null, typeof message === 'string' ? message : null]
  }
  return [null, null]
}

function errorOf(call: string): ErrorOf {
  return (response: Response, text: string): Error => {
    const [kind, message] = errorParts(text)
    const detail = [kind, message].filter((part): part is string => part !== null && part !== '')
    const suffix = detail.length > 0 ? `: ${detail.join(': ')}` : ''
    return new AirtableApiError(
      `Airtable API error (${call}): HTTP ${String(response.status)}${suffix}`,
      response.status,
      kind,
    )
  }
}

// A 429 means either "slow down" (RATE_LIMIT_REACHED) or "this workspace
// spent its monthly calls"; waiting only helps the first.
function retryable(_status: number, text: string): boolean {
  return errorParts(text)[0] !== 'PUBLIC_API_BILLING_LIMIT_EXCEEDED'
}

// After a 429 Airtable refuses every request to the base for 30 seconds, so
// a retry sooner than that is spent inside the penalty; 502 and 503 are
// documented as safe to retry with backoff.
export const RETRY: RetryPolicy = {
  statuses: new Set([429, 502, 503]),
  maxRetries: 2,
  maxBackoff: 30,
  delaySource: 'header',
  retryable,
  minDelays: { 429: 30 },
}

// A write retries only the 429, which Airtable answers before it applies
// anything. A 502 or 503 may come back after the records landed, and a
// retried create would make them twice.
export const WRITE_RETRY: RetryPolicy = {
  statuses: new Set([429]),
  maxRetries: 2,
  maxBackoff: 30,
  delaySource: 'header',
  retryable,
  minDelays: { 429: 30 },
}

interface RequestOptions {
  params?: Record<string, string | number> | undefined
  query?: string
  json?: unknown
  retry?: RetryPolicy
}

async function request(
  accessor: AirtableAccessor,
  method: string,
  path: string,
  paceKey: string,
  options: RequestOptions = {},
): Promise<unknown> {
  await accessor.limiter.acquire(paceKey)
  const url = `${accessor.baseUrl}${path}`
  const query = options.query ?? ''
  const headers: Record<string, string> = { Authorization: `Bearer ${accessor.config.token}` }
  if (options.json !== undefined) headers['Content-Type'] = 'application/json'
  return apiRequest(method, query === '' ? url : `${url}?${query}`, {
    errorOf: errorOf(`${method} ${path}`),
    headers,
    params: options.params,
    json: options.json,
    retry: options.retry ?? RETRY,
    fetchFn: accessor.fetchFn,
  })
}

function get(
  accessor: AirtableAccessor,
  path: string,
  params: Record<string, string | number> | undefined,
  paceKey: string,
): Promise<unknown> {
  return request(accessor, 'GET', path, paceKey, { params })
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function records(values: readonly unknown[]): Record<string, unknown>[] {
  return values.filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v),
  )
}

const segment = encodeURIComponent

function tablePath(baseId: string, table: string): string {
  return `/${segment(baseId)}/${segment(table)}`
}

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += MAX_BATCH) {
    out.push(items.slice(start, start + MAX_BATCH))
  }
  return out
}

function recordsOf(data: unknown): Record<string, unknown>[] {
  const rows = asRecord(data).records
  return Array.isArray(rows) ? records(rows as unknown[]) : []
}

async function page(
  accessor: AirtableAccessor,
  baseId: string,
  path: string,
  params: Record<string, string | number>,
  cursor: string | null,
): Promise<Record<string, unknown>> {
  return asRecord(
    await get(accessor, path, cursor !== null ? { ...params, offset: cursor } : params, baseId),
  )
}

/** Every base the token reaches, narrowed to the configured `baseIds`. */
export async function listBases(accessor: AirtableAccessor): Promise<Record<string, unknown>[]> {
  const bases = await cursorItems(
    async (cursor) =>
      asRecord(
        await get(
          accessor,
          '/meta/bases',
          cursor !== null ? { offset: cursor } : undefined,
          META_KEY,
        ),
      ),
    undefined,
    BASES,
  )
  const wanted = accessor.baseIds
  return records(bases).filter((base) => wanted === null || wanted.includes(String(base.id)))
}

/** A base's schema: its tables with their fields and views. */
export async function listTables(
  accessor: AirtableAccessor,
  baseId: string,
): Promise<Record<string, unknown>[]> {
  const data = asRecord(
    await get(accessor, `/meta/bases/${segment(baseId)}/tables`, undefined, baseId),
  )
  return Array.isArray(data.tables) ? records(data.tables as unknown[]) : []
}

/**
 * A table's records in the API's order, or a view's. Without a view
 * Airtable calls the order arbitrary; it is the order the table hands out,
 * stable between calls, and the only one a `maxRecords` prefix agrees with.
 * The table and the view are named by id or by name; `formula` is
 * `filterByFormula`, listing only the records it is true for; `maxRecords`
 * stops after that many records, both on the wire and in the collector.
 */
export async function listRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  options: { view?: string; formula?: string; maxRecords?: number } = {},
): Promise<Record<string, unknown>[]> {
  const params: Record<string, string | number> = { pageSize: PAGE_SIZE }
  if (options.view !== undefined) params.view = options.view
  if (options.formula !== undefined) params.filterByFormula = options.formula
  if (options.maxRecords !== undefined) params.maxRecords = options.maxRecords
  const path = tablePath(baseId, tableId)
  const found = await cursorItems(
    (cursor) => page(accessor, baseId, path, params, cursor),
    options.maxRecords,
    RECORDS,
  )
  return records(found)
}

/** One record by id; the table is named by id or by name. */
export async function getRecord(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  recordId: string,
): Promise<Record<string, unknown>> {
  return asRecord(
    await get(accessor, `${tablePath(baseId, tableId)}/${segment(recordId)}`, undefined, baseId),
  )
}

/**
 * Create records ten to a request, yielding each request's records. Each
 * entry is a new record's cell map, keyed by field name; `typecast` lets
 * Airtable convert string values to the field types. A request that fails
 * throws after every earlier one landed, so the caller holds exactly what
 * was written.
 */
export async function* createRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  cells: readonly Record<string, unknown>[],
  options: { typecast?: boolean } = {},
): AsyncGenerator<Record<string, unknown>[]> {
  const path = tablePath(baseId, tableId)
  for (const batch of batches(cells)) {
    const body: Record<string, unknown> = { records: batch.map((fields) => ({ fields })) }
    if (options.typecast === true) body.typecast = true
    yield recordsOf(
      await request(accessor, 'POST', path, baseId, { json: body, retry: WRITE_RETRY }),
    )
  }
}

/**
 * Patch records ten to a request, yielding each request's records. A
 * PATCH, never a PUT: a cell the update leaves out keeps its value. Each
 * entry is a record id and the cells to change, keyed by field name.
 */
export async function* updateRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  updates: readonly (readonly [string, Record<string, unknown>])[],
  options: { typecast?: boolean } = {},
): AsyncGenerator<Record<string, unknown>[]> {
  const path = tablePath(baseId, tableId)
  for (const batch of batches(updates)) {
    const body: Record<string, unknown> = {
      records: batch.map(([id, fields]) => ({ id, fields })),
    }
    if (options.typecast === true) body.typecast = true
    yield recordsOf(
      await request(accessor, 'PATCH', path, baseId, { json: body, retry: WRITE_RETRY }),
    )
  }
}

/**
 * Delete records ten to a request, yielding each request's answer. The ids
 * ride the query string as `records[]`, which is the only place the
 * endpoint reads them from.
 */
export async function* deleteRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  recordIds: readonly string[],
): AsyncGenerator<Record<string, unknown>[]> {
  const path = tablePath(baseId, tableId)
  for (const batch of batches(recordIds)) {
    const query = new URLSearchParams(batch.map((id) => ['records[]', id])).toString()
    yield recordsOf(await request(accessor, 'DELETE', path, baseId, { query, retry: WRITE_RETRY }))
  }
}

/** A record's comments in the API's order, newest first. */
export async function listComments(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  recordId: string,
): Promise<Record<string, unknown>[]> {
  const path = `${tablePath(baseId, tableId)}/${segment(recordId)}/comments`
  const found = await cursorItems(
    (cursor) => page(accessor, baseId, path, { pageSize: PAGE_SIZE }, cursor),
    undefined,
    COMMENTS,
  )
  return records(found)
}

/** Comment on a record as the token's user. */
export async function createComment(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  recordId: string,
  text: string,
): Promise<Record<string, unknown>> {
  return asRecord(
    await request(
      accessor,
      'POST',
      `${tablePath(baseId, tableId)}/${segment(recordId)}/comments`,
      baseId,
      { json: { text }, retry: WRITE_RETRY },
    ),
  )
}
