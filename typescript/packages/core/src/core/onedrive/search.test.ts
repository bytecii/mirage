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

import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { readdir } from './readdir.ts'
import { filesContaining } from './search.ts'

const BASE = 'https://graph.microsoft.com/v1.0/me/drive'
const DOCS = [{ id: '3', name: 'b.txt', size: 7, file: {} }]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

// Answers each Graph URL from a table keyed by its path, query left off.
function graph(routes: Record<string, () => Response>): string[] {
  const seen: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = decodeURIComponent(String(input instanceof Request ? input.url : input))
      seen.push(url)
      const route = routes[url.split('?')[0] ?? '']
      return Promise.resolve(
        route === undefined ? json({ error: { code: 'itemNotFound' } }, 404) : route(),
      )
    }),
  )
  return seen
}

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/od' : `/od/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

function accessor(): OneDriveAccessor {
  return new OneDriveAccessor({ accessToken: 'tok' })
}

describe('onedrive filesContaining', () => {
  it('answers the walked files Graph names', async () => {
    graph({
      [`${BASE}/root/children`]: () =>
        json({
          value: [
            { id: '1', name: 'a.txt', size: 7, file: {} },
            { id: '2', name: 'c.txt', size: 7, file: {} },
            { id: '9', name: 'Docs', folder: { childCount: 1 } },
          ],
        }),
      [`${BASE}/root:/Docs:/children`]: () => json({ value: DOCS }),
      [`${BASE}/root/search(q='wombat')`]: () =>
        json({ value: [{ id: '3' }, { id: '1' }, { id: '9' }] }),
    })
    const out = await filesContaining(accessor(), 'wombat', [scope()], new RAMIndexCacheStore())
    expect(out?.map((p) => p.virtual).sort()).toEqual(['/od/Docs/b.txt', '/od/a.txt'])
  })

  it('searches a subfolder scope from its folder', async () => {
    graph({
      [`${BASE}/root:/Docs:/children`]: () => json({ value: DOCS }),
      [`${BASE}/root:/Docs:/search(q='wombat')`]: () => json({ value: [{ id: '3' }] }),
    })
    const out = await filesContaining(
      accessor(),
      'wombat',
      [scope('Docs')],
      new RAMIndexCacheStore(),
    )
    expect(out?.map((p) => [p.virtual, p.vfsPath])).toEqual([['/od/Docs/b.txt', 'Docs/b.txt']])
  })

  it('answers null when a listed file has no id', async () => {
    const index = new RAMIndexCacheStore()
    graph({
      [`${BASE}/root:/Docs:/children`]: () =>
        json({ value: [...DOCS, { id: '4', name: 'd.txt', file: {} }] }),
      [`${BASE}/root:/Docs:/search(q='wombat')`]: () => json({ value: [{ id: '3' }] }),
    })
    await readdir(accessor(), scope('Docs'), index)
    const entry = (await index.get('/od/Docs/d.txt')).entry
    if (entry === null || entry === undefined) throw new Error('d.txt not indexed')
    delete entry.extra.id
    await index.put('/od/Docs/d.txt', entry)
    expect(await filesContaining(accessor(), 'wombat', [scope('Docs')], index)).toBeNull()
  })

  it('answers null for no hit or a failed search', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const reply of [() => json({ value: [] }), () => json({ error: { code: 'x' } }, 400)]) {
      graph({
        [`${BASE}/root:/Docs:/children`]: () => json({ value: DOCS }),
        [`${BASE}/root:/Docs:/search(q='wombat')`]: reply,
      })
      expect(
        await filesContaining(accessor(), 'wombat', [scope('Docs')], new RAMIndexCacheStore()),
      ).toBeNull()
    }
  })
})
