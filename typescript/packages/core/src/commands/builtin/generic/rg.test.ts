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
import { materialize, type ByteSource, type IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { labelled, rgGeneric } from './rg.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const FILES: Record<string, string> = {
  '/a.txt': 'hello\nworld\n',
  '/b.txt': 'hello\nworld\nfoo\nbar\nbaz\n',
  '/sub/nested.txt': 'nested\ncontent\n',
}
const DIRS = new Set(['/sub'])

function spec(path: string): PathSpec {
  return new PathSpec({ virtual: path, directory: path, resolved: true, vfsPath: path.slice(1) })
}

// How the classifier hands a typed `-` over: resolved under the cwd,
// spelled as typed.
function stdinOperand(raw = '-'): PathSpec {
  const virtual = raw === '/dev/stdin' ? '/dev/stdin' : '/-'
  return new PathSpec({
    virtual,
    directory: '/',
    resolved: true,
    vfsPath: virtual.slice(1),
    rawPath: raw,
  })
}

const stat = (p: PathSpec): Promise<FileStat> => {
  if (DIRS.has(p.virtual)) {
    return Promise.resolve(new FileStat({ name: p.virtual.slice(1), type: FileType.DIRECTORY }))
  }
  return FILES[p.virtual] === undefined
    ? Promise.reject(new Error(`ENOENT: ${p.virtual}`))
    : Promise.resolve(new FileStat({ name: p.virtual.slice(1), type: FileType.FILE }))
}

const readdir = (p: PathSpec): Promise<string[]> =>
  DIRS.has(p.virtual)
    ? Promise.resolve(Object.keys(FILES).filter((f) => f.startsWith(`${p.virtual}/`)))
    : Promise.reject(new Error(`ENOTDIR: ${p.virtual}`))

async function* stream(p: PathSpec): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  const content = FILES[p.virtual]
  if (content === undefined) throw new Error(`ENOENT: ${p.virtual}`)
  yield ENC.encode(content)
}

async function run(
  paths: PathSpec[],
  pattern: string,
  flags: Record<string, string | boolean | number | string[]>,
  stdin: ByteSource | null,
): Promise<[string, number]> {
  const opts = { stdin, flags, filetypeFns: null, cwd: '/' } as unknown as CommandOpts
  const [out, io] = (await rgGeneric(paths, [pattern], opts, stat, readdir, stream)) as [
    ByteSource,
    IOResult,
  ]
  const text = DEC.decode(await materialize(out))
  return [text, io.exitCode]
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* endlessAfterFirstMatch(): AsyncIterable<Uint8Array> {
  yield ENC.encode('hello\n')
  throw new Error('the probe read past the first selected line')
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* pipeThatGoesOn(first: string): AsyncIterable<Uint8Array> {
  yield ENC.encode(first)
  throw new Error('read past the answer')
}

describe('rgGeneric - operand', () => {
  it('reads stdin', async () => {
    // ripgrep 14.1.1: `printf 'b\n' | rg b -` prints `b`, exit 0. The
    // backend holds no `/-`, so reading one would fail the line.
    expect(await run([stdinOperand()], 'b', {}, ENC.encode('b\n'))).toEqual(['b\n', 0])
  })

  it('is named <stdin> beside a file', async () => {
    const paths = [stdinOperand(), spec('/a.txt')]
    expect(await run(paths, 'world', {}, ENC.encode('world\n'))).toEqual([
      '<stdin>:world\n/a.txt:world\n',
      0,
    ])
    expect(await run(paths, 'world', { c: true }, ENC.encode('world\n'))).toEqual([
      '<stdin>:1\n/a.txt:1\n',
      0,
    ])
  })

  it('reads stdin once when named twice', async () => {
    // Both operands read one cursor: the second finds it drained.
    const paths = [stdinOperand(), stdinOperand()]
    expect(await run(paths, 'b', {}, ENC.encode('b\n'))).toEqual(['<stdin>:b\n', 0])
    expect(await run(paths, 'z', { files_without_match: true }, ENC.encode('b\n'))).toEqual([
      '<stdin>\n<stdin>\n',
      0,
    ])
  })

  it('names stdin in a listing', async () => {
    const paths = [stdinOperand()]
    expect(await run(paths, 'b', { args_l: true }, ENC.encode('b\n'))).toEqual(['<stdin>\n', 0])
    expect(await run(paths, 'z', { args_l: true }, ENC.encode('b\n'))).toEqual(['', 1])
    expect(await run(paths, 'z', { files_without_match: true }, ENC.encode('b\n'))).toEqual([
      '<stdin>\n',
      0,
    ])
    expect(await run(paths, 'b', { files_without_match: true }, ENC.encode('b\n'))).toEqual(['', 1])
  })

  it.each([[{ args_l: true }], [{ files_without_match: true }]])(
    'stops a listing at the first match: %j',
    async (flags) => {
      // The listing is settled by the first selected line, so an endless
      // stdin is never read past it.
      const result = await run([stdinOperand()], 'hello', flags, endlessAfterFirstMatch())
      expect(result).toEqual('args_l' in flags ? ['<stdin>\n', 0] : ['', 1])
    },
  )

  it('is never filtered by --type or --glob', async () => {
    // ripgrep searches an explicit operand whatever --type or --glob say,
    // and stdin is always explicit.
    for (const flags of [{ type: 'py' }, { glob: '*.rs' }]) {
      expect(await run([stdinOperand()], 'b', flags, ENC.encode('b\n'))).toEqual(['b\n', 0])
    }
  })

  it('prints context', async () => {
    expect(await run([stdinOperand()], 'b', { C: '1' }, ENC.encode('a\nb\nc\n'))).toEqual([
      'a\nb\nc\n',
      0,
    ])
  })

  it.each([
    [{ m: '1', C: '1' }, false, 'a\nb\nc\n'],
    [{ m: '1', type: 'py' }, false, 'b\n'],
    [{ m: '1' }, true, '<stdin>:b\n'],
  ])('stops reading at max count: %j', async (flags, besideFile, want) => {
    // -m is answered once its last selected line (and that line's trailing
    // context) is out, so a pipe that goes on is never waited on: in the
    // full-scan branch (context, --type) and beside a file.
    const paths = besideFile ? [stdinOperand(), spec('/a.txt')] : [stdinOperand()]
    expect(await run(paths, 'b', flags, pipeThatGoesOn('a\nb\nc\n'))).toEqual([want, 0])
  })

  it('reads /dev/stdin under its own name', async () => {
    // ripgrep opens /dev/stdin as the path it is, so a label names it.
    const paths = [stdinOperand('/dev/stdin'), spec('/a.txt')]
    expect(await run(paths, 'world', {}, ENC.encode('world\n'))).toEqual([
      '/dev/stdin:world\n/a.txt:world\n',
      0,
    ])
  })
})

describe('rgGeneric - no operand', () => {
  it.each([
    [{ args_l: true }, 'b\n', ['<stdin>\n', 0]],
    [{ H: true }, 'b\n', ['<stdin>:b\n', 0]],
    [{ H: true, c: true }, 'b\n', ['<stdin>:1\n', 0]],
    [{ C: '1' }, 'a\nb\nc\n', ['a\nb\nc\n', 0]],
    [{ type: 'rust' }, 'b\n', ['b\n', 0]],
    [{ args_l: true, m: '0' }, 'b\n', ['', 1]],
  ])('searches stdin as an implicit `-`: %j', async (flags, data, want) => {
    // ripgrep 14.1.1 searches a piped stdin as an implicit `-` when the line
    // names no path, so every flag answers as it does for a typed one:
    // `printf 'b\n' | rg -l b` prints `<stdin>`.
    expect(await run([], 'b', flags, ENC.encode(data))).toEqual(want)
  })

  it.each([
    [{ args_l: true }, '<stdin>\n'],
    [{ m: '1', C: '1' }, 'a\nb\nc\n'],
    [{ m: '1', H: true }, '<stdin>:b\n'],
  ])('stops reading at the answer: %j', async (flags, want) => {
    expect(await run([], 'b', flags, pipeThatGoesOn('a\nb\nc\n'))).toEqual([want, 0])
  })
})

describe('rgGeneric - labelled context', () => {
  it.each([
    [{ A: '1' }, ['/b.txt', '/b.txt'], '/b.txt:world\n/b.txt-foo\n--\n/b.txt:world\n/b.txt-foo\n'],
    [{ H: true, n: true, C: '1' }, ['/b.txt'], '/b.txt-1-hello\n/b.txt:2:world\n/b.txt-3-foo\n'],
    [{ args_I: true, A: '1' }, ['/b.txt', '/b.txt'], 'world\nfoo\n--\nworld\nfoo\n'],
  ])('prints context under labels: %j %j', async (flags, paths, want) => {
    // ripgrep 14.1.1 leads a context line with `name-` and a match with
    // `name:`, and puts `--` between one file's context and the next file's,
    // labelled or not.
    expect(await run(paths.map(spec), 'world', flags, null)).toEqual([want, 0])
  })

  it('prints stdin context beside a file', async () => {
    // `printf 'a\nb\nc\n' | rg -C1 b - b.txt` on ripgrep 14.1.1.
    const paths = [stdinOperand(), spec('/b.txt')]
    expect(await run(paths, 'b', { C: '1' }, ENC.encode('a\nb\nc\n'))).toEqual([
      '<stdin>-a\n<stdin>:b\n<stdin>-c\n--\n/b.txt-foo\n/b.txt:bar\n/b.txt:baz\n',
      0,
    ])
  })

  it.each([
    [{}, '/sub/nested.txt:content\n'],
    [{ c: true }, '/sub/nested.txt:1\n'],
  ])('walks a directory named after a file: %j', async (flags, want) => {
    // `rg content b.txt sub` on ripgrep 14.1.1. Only the first operand was
    // probed, so a later directory was read as a file and reported.
    expect(await run([spec('/b.txt'), spec('/sub')], 'content', flags, null)).toEqual([want, 0])
  })

  it.each([
    [['/b.txt'], null],
    [[], ENC.encode('hello\nworld\nfoo\nbar\nbaz\n')],
  ])('prints a selected line past -m as selected: %j', async (paths, stdin) => {
    // `rg -n -m1 -A1 o b.txt` prints `2:world` on ripgrep 14.1.1, where GNU
    // grep prints `2-world`: past -m, a trailing line that would be selected
    // still prints as selected.
    expect(await run(paths.map(spec), 'o', { n: true, m: '1', A: '1' }, stdin)).toEqual([
      '1:hello\n2:world\n',
      0,
    ])
  })
})

describe('labelled', () => {
  const base: CommandOpts = { stdin: null, flags: {}, filetypeFns: null, cwd: '/' }

  it('asks for the filename a walk would have printed', () => {
    expect(labelled(base).flags).toEqual({ H: true })
  })

  it('lets -I win', () => {
    const opts = { ...base, flags: { args_I: true } }
    expect(labelled(opts)).toBe(opts)
  })
})
