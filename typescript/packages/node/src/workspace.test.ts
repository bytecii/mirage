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
import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { Workspace } from './workspace.ts'

describe('@struktoai/mirage-node Workspace', () => {
  it('lazy-loads the shell parser via readFileSync(require.resolve(...)) on first execute()', async () => {
    const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
    const res = await ws.execute('echo hi')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('reuses the cached parser across multiple execute() calls', async () => {
    const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
    const r1 = await ws.execute('echo one')
    const r2 = await ws.execute('echo two')
    expect(new TextDecoder().decode(r1.stdout)).toBe('one\n')
    expect(new TextDecoder().decode(r2.stdout)).toBe('two\n')
    await ws.close()
  })

  it('respects an explicitly provided shellParserFactory', async () => {
    let calls = 0
    const ws = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParserFactory: async () => {
          calls += 1
          const { createShellParser } = await import('@struktoai/mirage-core')
          const { readFileSync } = await import('node:fs')
          const { createRequire } = await import('node:module')
          const requireCjs = createRequire(import.meta.url)
          return createShellParser({
            engineWasm: readFileSync(requireCjs.resolve('web-tree-sitter/web-tree-sitter.wasm')),
            grammarWasm: readFileSync(requireCjs.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
          })
        },
      },
    )
    await ws.execute('echo a')
    await ws.execute('echo b')
    expect(calls).toBe(1)
    await ws.close()
  })

  it.each([['-maxdepth abc'], ['-mindepth xx'], ["-size ''"], ['-size abc'], ['-mtime abc']])(
    'find %s exits 1 with a clean stderr instead of crashing',
    async (expr) => {
      const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
      const res = await ws.execute(`find / ${expr}`)
      expect(res.exitCode).toBe(1)
      const stderr = new TextDecoder().decode(res.stderr)
      expect(stderr.startsWith('find: invalid argument ')).toBe(true)
      expect(stderr.endsWith('\n')).toBe(true)
      await ws.close()
    },
  )

  it.each([
    ["echo a '' b", 'a  b\n'],
    ['echo a "" b', 'a  b\n'],
  ])('keeps a quoted empty string as a real argument: %s', async (cmd, expected) => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const res = await ws.execute(cmd)
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe(expected)
    await ws.close()
  })
})
