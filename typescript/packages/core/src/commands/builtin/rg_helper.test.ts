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
import { FileStat, FileType } from '../../types.ts'
import { rgFull, type RgFullOptions } from './rg_helper.ts'

const ENC = new TextEncoder()

const FILES: Record<string, string> = {
  '/db/a.txt': 'Graph\nplain\nGraph again\n',
  '/db/b.txt': 'nothing here\n',
}

function readdirFn(path: string): Promise<string[]> {
  if (path === '/db') return Promise.resolve(['/db/a.txt', '/db/b.txt'])
  return Promise.reject(new Error(`not a dir: ${path}`))
}

function statFn(path: string): Promise<FileStat> {
  if (path === '/db') {
    return Promise.resolve(new FileStat({ name: 'db', type: FileType.DIRECTORY }))
  }
  const content = FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  const name = path.split('/').pop() ?? ''
  return Promise.resolve(new FileStat({ name, type: FileType.TEXT, size: content.length }))
}

function readBytesFn(path: string): Promise<Uint8Array> {
  const content = FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(ENC.encode(content))
}

function opts(overrides: Partial<RgFullOptions> = {}): RgFullOptions {
  return {
    ignoreCase: false,
    invert: false,
    lineNumbers: false,
    countOnly: false,
    filesOnly: false,
    fixedString: false,
    onlyMatching: false,
    maxCount: null,
    wholeWord: false,
    contextBefore: 0,
    contextAfter: 0,
    fileType: null,
    globPattern: null,
    hidden: false,
    ...overrides,
  }
}

describe('rgFull countOnly', () => {
  it('prints path:count per matching file and omits zero-count files', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual(['/db/a.txt:2'])
  })

  it('prints a bare count for a single file with matches', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db/a.txt',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual(['2'])
  })

  it('returns nothing for a single file without matches', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db/b.txt',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual([])
  })

  it('still prefixes content matches with the file path in directory walks', async () => {
    const out = await rgFull(readdirFn, statFn, readBytesFn, '/db', 'Graph', opts(), null)
    expect(out).toEqual(['/db/a.txt:Graph', '/db/a.txt:Graph again'])
  })
})
