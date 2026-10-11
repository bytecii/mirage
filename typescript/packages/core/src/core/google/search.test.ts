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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DriveModule from './drive.ts'

const drive = vi.hoisted(() => ({
  ids: [] as string[],
  complete: true,
  fail: null as Error | null,
  asked: [] as unknown[][],
}))

vi.mock('./drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('./drive.ts')
  return {
    ...actual,
    searchFiles: (_tm: unknown, text: string, parents: string[], mime: string | null) => {
      drive.asked.push([text, parents, mime])
      if (drive.fail !== null) return Promise.reject(drive.fail)
      return Promise.resolve({ ids: drive.ids, complete: drive.complete })
    },
  }
})

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { DOCS_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { driveQueries, filesContaining } from './search.ts'

const MIME = 'application/vnd.google-apps.document'
const CORPORA: Record<string, [string, string][]> = {
  owned: [
    ['a', 'doc-a'],
    ['b', 'doc-b'],
  ],
  shared: [['c', 'doc-c']],
}

async function readdir(
  _accessor: GoogleApiAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const key = path.vfsPath.replace(/^\/+|\/+$/g, '')
  const entries = (CORPORA[key] ?? []).map(([name, id]): [string, IndexEntry] => [
    `${name}.gdoc.json`,
    new IndexEntry({ id, name, resourceType: 'gdocs/file', vfsName: `${name}.gdoc.json` }),
  ])
  await index?.setDir(`/docs/${key}`, entries)
  return entries.map(([name]) => `/docs/${key}/${name}`)
}

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/docs' : `/docs/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

function ask(text: string, under: PathSpec[]): Promise<PathSpec[] | null> {
  const accessor = { tokenManager: null } as unknown as GoogleApiAccessor
  return filesContaining(accessor, readdir, MIME, DOCS_WORDS, text, under, new RAMIndexCacheStore())
}

beforeEach(() => {
  drive.ids = []
  drive.complete = true
  drive.fail = null
  drive.asked = []
})

// Twin of python/tests/core/google/test_search.py.
describe('google app filesContaining', () => {
  it.each<[string, string[] | null]>([
    ['wombat', ['wombat']],
    ['Wombat', ['Wombat']],
    ['notes', ['notes', 'otes']],
    ['q4', null],
    ['2024', null],
    ['paragraph', null],
    ['TextRun', null],
    ['NORMAL_TEXT', null],
    ['false', null],
    ['arial', null],
    ['https', null],
    ['face', null],
  ])('driveQueries(%j) is %j', (text, queries) => {
    expect(driveQueries(text, DOCS_WORDS)).toEqual(queries)
  })

  it('answers the walked files Drive names', async () => {
    drive.ids = ['doc-a', 'doc-c', 'elsewhere']
    const out = await ask('wombat', [scope()])
    expect(out?.map((p) => p.virtual)).toEqual([
      '/docs/owned/a.gdoc.json',
      '/docs/shared/c.gdoc.json',
    ])
    expect(drive.asked).toEqual([['wombat', [], MIME]])
  })

  it('walks only a corpus scope', async () => {
    drive.ids = ['doc-a', 'doc-c']
    const out = await ask('wombat', [scope('owned')])
    expect(out?.map((p) => p.vfsPath)).toEqual(['owned/a.gdoc.json'])
  })

  it.each<[string, string, string[], boolean, Error | null]>([
    ['paragraph', '', ['doc-a'], true, null],
    ['wombat', 'owned/a.gdoc.json', ['doc-a'], true, null],
    ['wombat', '', ['doc-a'], false, null],
    ['wombat', '', [], true, null],
    ['wombat', '', ['doc-a'], true, new TypeError('down')],
  ])('reads every file for %j under %j when unsure', async (text, under, ids, complete, fail) => {
    drive.ids = ids
    drive.complete = complete
    drive.fail = fail
    expect(await ask(text, [scope(under)])).toBeNull()
  })

  it('asks each query and joins the answers', async () => {
    drive.ids = ['doc-b']
    const out = await ask('notes', [scope('owned')])
    expect(out?.map((p) => p.vfsPath)).toEqual(['owned/b.gdoc.json'])
    expect(drive.asked.map(([query]) => query)).toEqual(['notes', 'otes'])
  })

  // Drive could not finish the listing, so its entries are cached but not the
  // directory, and grep's own walk lists it again and may find more.
  it('reads every file after an unfinished listing', async () => {
    drive.ids = ['a.gdoc.json']
    const unfinished = async (
      accessor: GoogleApiAccessor,
      path: PathSpec,
      index?: IndexCacheStore,
    ): Promise<string[]> => {
      const listed = await readdir(accessor, path, new RAMIndexCacheStore())
      for (const name of listed) {
        const leaf = name.split('/').at(-1) ?? name
        await index?.put(name, new IndexEntry({ id: leaf, name: leaf, resourceType: 'gdocs/file' }))
      }
      return listed
    }
    const accessor = { tokenManager: null } as unknown as GoogleApiAccessor
    expect(
      await filesContaining(
        accessor,
        unfinished,
        MIME,
        DOCS_WORDS,
        'wombat',
        [scope('owned')],
        new RAMIndexCacheStore(),
      ),
    ).toBeNull()
  })
})
