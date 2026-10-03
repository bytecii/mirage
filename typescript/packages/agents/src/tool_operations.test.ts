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

import { beforeEach, describe, expect, it } from 'vitest'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { MirageToolOperations } from './tool_operations.ts'

let ws: Workspace
let ops: MirageToolOperations

beforeEach(() => {
  ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  ops = new MirageToolOperations(ws)
})

describe('grep', () => {
  it('reports matches as a success', async () => {
    await ws.vfs.write('/search.txt', 'hello world\ngoodbye world\n')
    const result = await ops.grep('hello', '/')
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('hello') as string })
    expect(result.isError).toBeUndefined()
  })

  it('reports no match as a success', async () => {
    // grep exits 1 when nothing matched. That is the empty answer, not
    // a broken search, so the agent must not be told the call failed.
    await ws.vfs.write('/search.txt', 'hello world\n')
    const result = await ops.grep('nothing-matches-this', '/')
    expect(result.isError).toBeUndefined()
  })

  it('reports a real failure as an error', async () => {
    // An unreadable path exits 2. Reported as a success, the diagnostic
    // would read to the agent like a search that found nothing.
    const result = await ops.grep('hello', '/nope.txt')
    expect(result.isError).toBe(true)
  })
})

describe('edit', () => {
  it('refuses an edit to a file that changed since it was read', async () => {
    await ws.vfs.write('/a.txt', 'hello world')
    await ops.read('/a.txt')
    await ws.vfs.write('/a.txt', 'hello there')
    const result = await ops.edit('/a.txt', 'hello', 'goodbye')
    expect(result.isError).toBe(true)
    expect(await ws.vfs.cat('/a.txt')).toBe('hello there')
  })

  it('overwrites when stale-write protection is off', async () => {
    const unchecked = new MirageToolOperations(ws, { staleWriteProtection: false })
    await ws.vfs.write('/a.txt', 'hello world')
    await unchecked.read('/a.txt')
    await ws.vfs.write('/a.txt', 'hello there')
    const result = await unchecked.edit('/a.txt', 'hello', 'goodbye')
    expect(result.isError).toBeUndefined()
    expect(await ws.vfs.cat('/a.txt')).toBe('goodbye there')
  })
})

describe('glob', () => {
  it('finds files by name under a path', async () => {
    await ops.write('/src/a.ts', 'a')
    await ops.write('/src/deep/b.ts', 'b')
    await ops.write('/src/c.txt', 'c')
    const result = await ops.glob('**/*.ts', '/src')
    expect((result.content[0]?.text ?? '').split(/\s+/).filter(Boolean)).toEqual([
      '/src/a.ts',
      '/src/deep/b.ts',
    ])
    expect(result.isError).not.toBe(true)
  })

  it('matches a pattern with directories in it', async () => {
    await ops.write('/src/deep/b.ts', 'b')
    const result = await ops.glob('src/**/*.ts')
    expect((result.content[0]?.text ?? '').trim()).toBe('/src/deep/b.ts')
  })

  it('follows a link to a file', async () => {
    await ops.write('/src/a.ts', 'a')
    await ops.shell('ln -s /src/a.ts /src/link.ts')
    await ops.shell('ln -s /src/none.ts /src/dangling.ts')
    const result = await ops.glob('*.ts', '/src')
    expect((result.content[0]?.text ?? '').split(/\s+/).filter(Boolean)).toEqual([
      '/src/a.ts',
      '/src/link.ts',
    ])
  })

  it('skips directories', async () => {
    await ops.write('/cache.ts/inner.txt', 'x')
    await ops.write('/src/a.ts', 'a')
    const result = await ops.glob('**/*.ts')
    expect((result.content[0]?.text ?? '').trim()).toBe('/src/a.ts')
  })

  it('matches only the named level', async () => {
    await ops.write('/src/a.ts', 'a')
    await ops.write('/src/deep/b.ts', 'b')
    const result = await ops.glob('*.ts', '/src')
    expect((result.content[0]?.text ?? '').trim()).toBe('/src/a.ts')
  })
})

describe('grep options', () => {
  it('takes the GNU flags', async () => {
    await ops.write('/src/a.py', 'Needle\nhay\n')
    await ops.write('/src/b.txt', 'needle\n')
    const loose = await ops.grep('needle', '/src', { ignoreCase: true, include: '*.py' })
    const names = await ops.grep('needle', '/src', { filesWithMatches: true })
    const counted = await ops.grep('e', '/src/a.py', { count: true })
    const literal = await ops.grep('-dash', '/src')
    expect(loose.content[0]?.text).toBe('/src/a.py:1:Needle\n')
    expect(names.content[0]?.text).toBe('/src/b.txt\n')
    expect(counted.content[0]?.text).toBe('1\n')
    expect(literal.isError).not.toBe(true)
  })
})

describe('write', () => {
  it('refuses an unread file', async () => {
    await ws.vfs.write('/exists.txt', 'first')
    const result = await ops.write('/exists.txt', 'second')
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('read all of it before overwriting it')
    expect(await ws.vfs.cat('/exists.txt')).toBe('first')
  })

  it('refuses a partly read file', async () => {
    await ws.vfs.write('/three.txt', '1\n2\n3\n')
    await ops.read('/three.txt', 0, 1)
    const result = await ops.write('/three.txt', 'x')
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('read all of it before overwriting it')
    expect(await ws.vfs.cat('/three.txt')).toBe('1\n2\n3\n')
  })

  it('overwrites a read file', async () => {
    await ws.vfs.write('/exists.txt', 'first')
    await ops.read('/exists.txt')
    const result = await ops.write('/exists.txt', 'second')
    expect(result.isError).not.toBe(true)
    expect(await ws.vfs.cat('/exists.txt')).toBe('second')
  })

  it('refuses a file changed since it was read', async () => {
    await ws.vfs.write('/exists.txt', 'first')
    await ops.read('/exists.txt')
    await ws.vfs.write('/exists.txt', 'moved')
    const result = await ops.write('/exists.txt', 'second')
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('changed since it was last read')
    expect(await ws.vfs.cat('/exists.txt')).toBe('moved')
  })
})
