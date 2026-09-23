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

export const BASES: PageShape = { itemsKey: 'bases', nextCursor: offsetCursor }
export const RECORDS: PageShape = { itemsKey: 'records', nextCursor: offsetCursor }

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

async function get(
  accessor: AirtableAccessor,
  path: string,
  params: Record<string, string | number> | undefined,
  paceKey: string,
): Promise<unknown> {
  await accessor.limiter.acquire(paceKey)
  return apiRequest('GET', `${accessor.baseUrl}${path}`, {
    errorOf: errorOf(`GET ${path}`),
    headers: { Authorization: `Bearer ${accessor.config.token}` },
    params,
    retry: RETRY,
    fetchFn: accessor.fetchFn,
  })
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
 * `maxRecords` stops after that many records, both on the wire and in the
 * collector.
 */
export async function listRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  options: { view?: string; maxRecords?: number } = {},
): Promise<Record<string, unknown>[]> {
  const params: Record<string, string | number> = { pageSize: PAGE_SIZE }
  if (options.view !== undefined) params.view = options.view
  if (options.maxRecords !== undefined) params.maxRecords = options.maxRecords
  const path = `/${segment(baseId)}/${segment(tableId)}`
  const found = await cursorItems(
    async (cursor) =>
      asRecord(
        await get(accessor, path, cursor !== null ? { ...params, offset: cursor } : params, baseId),
      ),
    options.maxRecords,
    RECORDS,
  )
  return records(found)
}
