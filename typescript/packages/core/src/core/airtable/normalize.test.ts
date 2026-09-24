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
import { normalizeBase, normalizeRecord, normalizeTable, recordsJsonl } from './normalize.ts'

const DEC = new TextDecoder()

describe('airtable normalize', () => {
  it('lists the tables in base.json', () => {
    expect(
      normalizeBase({ id: 'appA', name: 'A', permissionLevel: 'read' }, [
        { id: 'tblT', name: 'T', primaryFieldId: 'fldP' },
      ]),
    ).toEqual({
      base_id: 'appA',
      base_name: 'A',
      permission_level: 'read',
      tables: [{ table_id: 'tblT', table_name: 'T', primary_field_id: 'fldP' }],
    })
  })

  it('keeps field types and options in table.json', () => {
    const out = normalizeTable(
      {
        id: 'tblT',
        name: 'T',
        primaryFieldId: 'fldP',
        fields: [
          { id: 'fldP', name: 'Name', type: 'singleLineText' },
          { id: 'fldS', name: 'Status', type: 'singleSelect', options: { choices: [] } },
        ],
        views: [{ id: 'viwG', name: 'Grid view', type: 'grid' }],
      },
      'appA',
    )
    expect(out.base_id).toBe('appA')
    expect((out.fields as unknown[])[1]).toEqual({
      field_id: 'fldS',
      field_name: 'Status',
      type: 'singleSelect',
      description: null,
      options: { choices: [] },
    })
    expect(out.views).toEqual([{ view_id: 'viwG', view_name: 'Grid view', type: 'grid' }])
  })

  it('passes a record through', () => {
    expect(
      normalizeRecord({
        id: 'recA',
        createdTime: '2026-01-01T00:00:00.000Z',
        fields: { Name: 'é', Link: ['recB'] },
      }),
    ).toEqual({
      record_id: 'recA',
      created_time: '2026-01-01T00:00:00.000Z',
      fields: { Name: 'é', Link: ['recB'] },
    })
    expect(normalizeRecord({ id: 'recC' }).fields).toEqual({})
  })

  it('renders one line per record in listing order', () => {
    const rows = DEC.decode(
      recordsJsonl([
        { id: 'rec2', fields: { Notes: 'a\nb' } },
        { id: 'rec1', fields: {} },
      ]),
    )
    const lines = rows.split('\n').filter((l) => l !== '')
    expect(lines.map((l) => (JSON.parse(l) as { record_id: string }).record_id)).toEqual([
      'rec2',
      'rec1',
    ])
    expect(recordsJsonl([]).byteLength).toBe(0)
  })
})
