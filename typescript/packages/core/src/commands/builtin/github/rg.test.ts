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

// Mirror of python/tests/commands/builtin/github/test_rg_search.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./pushdown.ts', () => ({ narrowScope: vi.fn() }))
vi.mock('../generic/rg.ts', () => ({ rgGeneric: vi.fn() }))

import { GitHubAccessor } from '../../../accessor/github.ts'
import type { GitHubTransport } from '../../../core/github/client.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { rgGeneric } from '../generic/rg.ts'
import { narrowScope } from './pushdown.ts'
import { GITHUB_RG } from './rg.ts'

const narrow = vi.mocked(narrowScope)
const generic = vi.mocked(rgGeneric)

function makeAccessor(): GitHubAccessor {
  const transport: GitHubTransport = {
    get(path: string): Promise<unknown> {
      throw new Error(`unexpected transport call: ${path}`)
    },
    request(method: string, path: string): Promise<unknown> {
      throw new Error(`unexpected transport call: ${method} ${path}`)
    },
    requestWithResponse(method: string, path: string): Promise<never> {
      throw new Error(`unexpected transport call: ${method} ${path}`)
    },
  }
  return new GitHubAccessor({
    transport,
    owner: 'o',
    repo: 'r',
    ref: 'main',
    defaultBranch: 'main',
    tree: {},
  })
}

const ROOT = new PathSpec({ virtual: '/', directory: '/', vfsPath: '', resolved: false })
const MAIN = new PathSpec({
  virtual: '/src/main.py',
  directory: '',
  vfsPath: 'src/main.py',
  resolved: true,
})

beforeEach(() => {
  narrow.mockReset()
  generic.mockReset()
  narrow.mockResolvedValue({ resolved: [MAIN], fileCount: 1, usedSearch: true })
  generic.mockResolvedValue([new Uint8Array(), new IOResult()])
})

describe('github rg push-down', () => {
  // The candidates stand in for a walk, which --type filters, while a file
  // named on the line is never filtered, so the wrapper filters them itself;
  // none left is no match, not a stdin run.
  it('hands the generic the candidates the walk would search', async () => {
    const cmd = GITHUB_RG[0]
    if (cmd === undefined) throw new Error('rg not registered')
    const opts = { stdin: null, flags: { w: true, type: 'py' }, filetypeFns: null, cwd: '/' }
    await cmd.fn(makeAccessor(), [ROOT], ['import'], opts as unknown as CommandOpts)
    expect((generic.mock.calls[0]?.[0] ?? []).map((p) => p.virtual)).toEqual(['/src/main.py'])
  })

  it('answers no match when the walk would search nothing', async () => {
    const cmd = GITHUB_RG[0]
    if (cmd === undefined) throw new Error('rg not registered')
    const opts = { stdin: null, flags: { w: true, type: 'md' }, filetypeFns: null, cwd: '/' }
    const result = await cmd.fn(makeAccessor(), [ROOT], ['import'], opts as unknown as CommandOpts)
    expect(generic).not.toHaveBeenCalled()
    const [out, io] = result as [ByteSource, IOResult]
    expect([(await materialize(out)).byteLength, io.exitCode]).toEqual([0, 1])
  })
})
