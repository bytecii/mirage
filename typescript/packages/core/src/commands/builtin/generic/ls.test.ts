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

import { mountKey } from '../../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandOpts } from '../../config.ts'
import { lsGeneric } from './ls.ts'

const DEC = new TextDecoder()

const MODIFIED: Record<string, string> = {
  'apple.txt': '2026-01-03T00:00:00Z',
  'Banana.txt': '2026-01-01T00:00:00Z',
  'CHERRY.txt': '2026-01-02T00:00:00Z',
}

function key(p: PathSpec): string {
  return rstripSlash(p.virtual) || '/'
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, ''),
  })
}

function opts(flags: Record<string, string | boolean | string[]>): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null,
  } as unknown as CommandOpts
}

const stat = (p: PathSpec): Promise<FileStat> => {
  const name = key(p).split('/').pop() ?? ''
  return Promise.resolve(
    new FileStat({
      name,
      type: key(p) === '/' ? FileType.DIRECTORY : FileType.TEXT,
      modified: MODIFIED[name] ?? null,
    }),
  )
}

const readdir = (p: PathSpec): Promise<string[]> => {
  if (key(p) === '/') return Promise.resolve(['/apple.txt', '/Banana.txt', '/CHERRY.txt'])
  return Promise.resolve([])
}

async function run(flags: Record<string, string | boolean | string[]>): Promise<string[]> {
  const result = await lsGeneric([spec('/')], opts(flags), readdir, stat)
  if (result === null) return []
  const [out] = result
  return DEC.decode(out as Uint8Array)
    .replace(/\n$/, '')
    .split('\n')
}

describe('lsGeneric', () => {
  it('sorts names by ASCII byte order, uppercase before lowercase', async () => {
    expect(await run({})).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })

  it('-r reverses the ASCII order', async () => {
    expect(await run({ r: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-t sorts newest first by codepoint comparison of modified', async () => {
    expect(await run({ t: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-tr sorts oldest first', async () => {
    expect(await run({ t: true, r: true })).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })
})

// Mirrors the Python generic ls operand tests: GNU prints file operands first
// with no header, then names every directory once more than one operand (or -R)
// is in play, blank-line separated.
const TREE: Record<string, FileType> = {
  '/a': FileType.DIRECTORY,
  '/a/f.txt': FileType.TEXT,
  '/a/sub': FileType.DIRECTORY,
  '/b': FileType.DIRECTORY,
  '/b/g.txt': FileType.TEXT,
  '/c': FileType.DIRECTORY,
  '/mfile': FileType.TEXT,
  '/zfile': FileType.TEXT,
}

const treeStat = (p: PathSpec): Promise<FileStat> => {
  const path = key(p)
  const type = TREE[path]
  if (type === undefined) return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
  return Promise.resolve(
    new FileStat({ name: path.split('/').pop() ?? '', type, size: type === FileType.TEXT ? 3 : 0 }),
  )
}

const treeReaddir = (p: PathSpec): Promise<string[]> => {
  const path = key(p)
  const type = TREE[path]
  if (type === undefined) return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
  if (type !== FileType.DIRECTORY) {
    return Promise.reject(Object.assign(new Error(path), { code: 'ENOTDIR' }))
  }
  const prefix = path === '/' ? '/' : `${path}/`
  return Promise.resolve(
    Object.keys(TREE).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')),
  )
}

async function runTree(
  paths: string[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await lsGeneric(paths.map(spec), opts(flags), treeReaddir, treeStat)
  if (result === null) return { stdout: '', stderr: '', exitCode: 0 }
  const [out, io] = result
  return {
    stdout: DEC.decode(out as Uint8Array),
    stderr: io.stderr === null ? '' : DEC.decode(io.stderr as Uint8Array),
    exitCode: io.exitCode,
  }
}

describe('lsGeneric operand headers', () => {
  it('a single directory operand has no header', async () => {
    expect((await runTree(['/a'])).stdout).toBe('f.txt\nsub\n')
  })

  it('two directory operands are headed and blank-line separated', async () => {
    const r = await runTree(['/a', '/b'])
    expect(r.stdout).toBe('/a:\nf.txt\nsub\n\n/b:\ng.txt\n')
    expect(r.exitCode).toBe(0)
  })

  it('an empty directory operand still gets a header', async () => {
    expect((await runTree(['/b', '/c'])).stdout).toBe('/b:\ng.txt\n\n/c:\n')
  })

  it('file operands print first, unheaded, then the directories', async () => {
    expect((await runTree(['/b', '/zfile', '/a', '/mfile'])).stdout).toBe(
      '/mfile\n/zfile\n\n/a:\nf.txt\nsub\n\n/b:\ng.txt\n',
    )
  })

  it('file operands alone emit no trailing blank line', async () => {
    expect((await runTree(['/zfile', '/mfile'])).stdout).toBe('/mfile\n/zfile\n')
  })

  it('operands sort by name, not command-line order', async () => {
    expect((await runTree(['/b', '/a'])).stdout).toBe('/a:\nf.txt\nsub\n\n/b:\ng.txt\n')
  })

  it('-r flips both the operand order and the entry order', async () => {
    expect((await runTree(['/a', '/b'], { r: true })).stdout).toBe(
      '/b:\ng.txt\n\n/a:\nsub\nf.txt\n',
    )
  })

  it('a failed operand still leaves the listed one headed', async () => {
    const r = await runTree(['/nope', '/a'])
    expect(r.stdout).toBe('/a:\nf.txt\nsub\n')
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('/nope')
  })

  it('a repeated operand lists twice', async () => {
    expect((await runTree(['/a', '/a'])).stdout).toBe('/a:\nf.txt\nsub\n\n/a:\nf.txt\nsub\n')
  })

  it('-R keeps the header on a lone operand', async () => {
    expect((await runTree(['/a'], { R: true })).stdout).toBe('/a:\nf.txt\nsub\n\n/a/sub:\n')
  })

  it('-R does not head a file operand', async () => {
    expect((await runTree(['/a', '/zfile'], { R: true })).stdout).toBe(
      '/zfile\n\n/a:\nf.txt\nsub\n\n/a/sub:\n',
    )
  })

  it('-d sorts its operands and stays unheaded', async () => {
    expect((await runTree(['/zfile', '/b', '/a'], { d: true })).stdout).toBe('/a\n/b\n/zfile\n')
  })
})
