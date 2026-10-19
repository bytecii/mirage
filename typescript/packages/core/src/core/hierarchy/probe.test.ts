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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { fileEntry, parentSpec } from './probe.ts'

function spec(mountPath: string): PathSpec {
  const key = stripSlash(mountPath)
  return new PathSpec({
    virtual: key !== '' ? `/h${mountPath}` : '/h',
    directory: '/h/',
    vfsPath: key,
  })
}

function thrownCode(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return (err as { code?: unknown }).code
  }
  return null
}

describe('hierarchy probe', () => {
  it('parentSpec is the directory holding the path', () => {
    const parent = parentSpec(spec('/rooms/red/a.json'))
    expect([parent.virtual, parent.vfsPath]).toEqual(['/h/rooms/red', 'rooms/red'])
  })

  it('fileEntry answers a file and refuses the rest', () => {
    const row = new FileStat({ name: 'a.json', type: FileType.FILE })
    expect(fileEntry(spec('/rooms/red/a.json'), row)).toBe(row)
    const folder = new FileStat({ name: 'red', type: FileType.DIRECTORY })
    expect(thrownCode(() => fileEntry(spec('/rooms/red'), folder))).toBe('EISDIR')
    expect(thrownCode(() => fileEntry(spec('/'), null))).toBe('EISDIR')
    expect(thrownCode(() => fileEntry(spec('/rooms/red/missing.json'), null))).toBe('ENOENT')
  })
})
