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
import { stat } from './stat.ts'

const NOT_FOUND = (): Response =>
  new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 })
const FILE = (): Response =>
  new Response(JSON.stringify({ id: 'item', name: 'a.txt', size: 3, file: {} }), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive readdir', () => {
  it('indexes a listing so a stat below it is answered with its cTag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          value: [
            {
              id: 'item',
              name: 'a.txt',
              size: 3,
              cTag: 'ctag-1',
              eTag: 'etag-1',
              lastModifiedDateTime: '2026-01-01T00:00:00Z',
              file: {},
            },
          ],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const index = new RAMIndexCacheStore()
    const folder = PathSpec.fromStrPath('/od/folder', 'folder')
    const file = PathSpec.fromStrPath('/od/folder/a.txt', 'folder/a.txt')

    expect(await readdir(accessor, folder, index)).toEqual(['/od/folder/a.txt'])
    expect(await stat(accessor, file, index)).toMatchObject({ size: 3, fingerprint: 'ctag-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Graph 404s the children of a missing name and of a name under a file
  // alike, so only the ancestor walk can tell GNU's "Not a directory" from
  // "No such file or directory".
  const underFile = (href: string): Response =>
    href.endsWith('/root:/a.txt') ? FILE() : NOT_FOUND()
  it.each([
    ['a.txt', 'ENOTDIR', underFile],
    ['a.txt/x', 'ENOTDIR', underFile],
    ['nope/deeper', 'ENOENT', NOT_FOUND],
  ])('lists %s as %s', async (key, code, answer) => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown) => Promise.resolve(answer(String(url)))),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const path = PathSpec.fromStrPath(`/od/${key}`, key)
    await expect(readdir(accessor, path, new RAMIndexCacheStore())).rejects.toMatchObject({ code })
  })

  it('keeps the cold order in a cached listing', async () => {
    // Graph may answer in UTF-16 order, which puts an astral name before a
    // private-use one; the index must hand back the code-point order the
    // cold listing returned, or a second walk reorders grep's output.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            value: [
              { id: '1', name: '\u{1F600}.txt', size: 1, file: {} },
              { id: '2', name: '\uE000.txt', size: 1, file: {} },
            ],
          }),
          { status: 200 },
        ),
      ),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const index = new RAMIndexCacheStore()
    const root = PathSpec.fromStrPath('/od', '')
    const cold = await readdir(accessor, root, index)
    expect(cold).toEqual(['/od/\uE000.txt', '/od/\u{1F600}.txt'])
    expect(await readdir(accessor, root, index)).toEqual(cold)
  })
})
