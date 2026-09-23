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

import { describe, expect, it } from 'vitest'
import {
  AirtableApiError,
  RETRY,
  errorParts,
  listBases,
  listRecords,
  listTables,
} from './client.ts'
import { FEATURES, FakeAirtable, OPS, ROADMAP, makeAccessor } from './_test_util.ts'

describe('airtable client', () => {
  it('reads every error body shape', () => {
    expect(errorParts('{"error": {"type": "X", "message": "m"}}')).toEqual(['X', 'm'])
    expect(errorParts('{"error": {"type": "LIST_RECORDS_ITERATOR_NOT_AVAILABLE"}}')).toEqual([
      'LIST_RECORDS_ITERATOR_NOT_AVAILABLE',
      null,
    ])
    expect(errorParts('{"error": "NOT_FOUND"}')).toEqual(['NOT_FOUND', null])
    expect(errorParts('not json')).toEqual([null, null])
    expect(errorParts('[1]')).toEqual([null, null])
  })

  it('vetoes only the billing cap', () => {
    expect(RETRY.retryable?.(429, '{"error": {"type": "RATE_LIMIT_REACHED"}}')).toBe(true)
    expect(RETRY.retryable?.(429, '{"error": {"type": "PUBLIC_API_BILLING_LIMIT_EXCEEDED"}}')).toBe(
      false,
    )
    expect(RETRY.minDelays?.[429]).toBe(30)
  })

  it("counts airtable's 403 answer as not found", () => {
    expect(new AirtableApiError('m', 404).notFound).toBe(true)
    expect(new AirtableApiError('m', 403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND').notFound).toBe(
      true,
    )
    expect(new AirtableApiError('m', 422, 'INVALID_REQUEST').notFound).toBe(false)
  })

  it('honors the configured base scope', async () => {
    const fake = new FakeAirtable()
    expect((await listBases(makeAccessor(fake))).map((b) => b.id)).toEqual([ROADMAP, OPS])
    expect((await listBases(makeAccessor(fake, { baseIds: [OPS] }))).map((b) => b.id)).toEqual([
      OPS,
    ])
  })

  it('names the call and the type on a bad token', async () => {
    const failure = listBases(makeAccessor(new FakeAirtable(), { token: 'wrong' }))
    await expect(failure).rejects.toThrow(
      'Airtable API error (GET /meta/bases): HTTP 401: AUTHENTICATION_REQUIRED: Authentication required',
    )
    await expect(failure).rejects.toMatchObject({
      status: 401,
      errorType: 'AUTHENTICATION_REQUIRED',
    })
  })

  it('returns the schema', async () => {
    const tables = await listTables(makeAccessor(new FakeAirtable()), ROADMAP)
    expect(tables.map((t) => t.id)).toEqual([FEATURES])
  })

  it('pages through every offset', async () => {
    const fake = new FakeAirtable()
    expect(await listRecords(makeAccessor(fake), ROADMAP, FEATURES)).toHaveLength(7)
    const calls = fake.recordCalls()
    expect(calls).toHaveLength(3)
    expect(calls[0]?.offset).toBeUndefined()
    expect(calls[1]?.offset).toBe('itrFakeIterator01/3')
    expect(calls.every((c) => c.pageSize === '100')).toBe(true)
  })

  it('sends maxRecords on the wire and stops the collector there', async () => {
    const fake = new FakeAirtable()
    const found = await listRecords(makeAccessor(fake), ROADMAP, FEATURES, { maxRecords: 2 })
    expect(found.map((r) => r.id)).toEqual(['rec00000000000001', 'rec00000000000002'])
    expect(fake.recordCalls()[0]?.maxRecords).toBe('2')
  })

  it('filters a view through the api', async () => {
    const found = await listRecords(makeAccessor(new FakeAirtable()), ROADMAP, FEATURES, {
      view: 'viwDone0000000001',
    })
    expect(found.map((r) => (r.fields as Record<string, unknown>).Priority)).toEqual([1, 3, 5, 7])
  })
})
