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

import type { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { csplitGeneric } from './csplit.ts'

const ENC = new TextEncoder()

async function runCsplit(flags: CommandOpts['flags']): Promise<[PathSpec[], IOResult]> {
  const specs: PathSpec[] = []
  const opts = {
    stdin: ENC.encode('a\nb\n'),
    flags,
    filetypeFns: null,
    cwd: '/',
    mountPrefix: '/data',
  } as CommandOpts
  const result = await csplitGeneric(
    [],
    ['2'],
    opts,
    () => {
      throw new Error('paths are empty; the source is stdin')
    },
    (p) => {
      specs.push(p)
      return Promise.resolve()
    },
  )
  const [, io] = result as [unknown, IOResult]
  return [specs, io]
}

// The executing mount's prefix names every output, and the writes keys stay
// mount-relative so the executor can prefix them. Mirrors test_csplit.py.
describe('csplit names outputs on the executing mount', () => {
  it('addresses stdin outputs by their virtual path', async () => {
    const [specs, io] = await runCsplit({})
    expect(specs.map((p) => [p.virtual, p.vfsPath])).toEqual([
      ['/data/xx00', 'xx00'],
      ['/data/xx01', 'xx01'],
    ])
    expect(Object.keys(io.writes)).toEqual(['/xx00', '/xx01'])
  })

  it('addresses a prefix path by its virtual path', async () => {
    const [specs, io] = await runCsplit({ prefix: '/data/sub/cs' })
    expect(specs.map((p) => p.virtual)).toEqual(['/data/sub/cs00', '/data/sub/cs01'])
    expect(Object.keys(io.writes)).toEqual(['/sub/cs00', '/sub/cs01'])
  })
})
