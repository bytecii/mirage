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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import type { RegisteredCommand } from '../../config.ts'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
import { gzip as gzipUtil, gunzip as gunzipUtil } from '../../../utils/compress.ts'
import { MountMode } from '../../../types.ts'
import { parseFlags } from '../../../workspace/executor/command/flags.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { specOf } from '../../spec/builtins.ts'
const RAM_GZIP = RAM_COMMANDS.filter((c) => c.name === 'gzip' && c.filetype == null)
const RAM_GUNZIP = RAM_COMMANDS.filter((c) => c.name === 'gunzip' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// What a registered command's writes predicate answers for a typed line,
// read through the same parse the executor hands the mount.
function writesFor(cmd: RegisteredCommand | undefined, argv: string[]): boolean {
  if (cmd?.writes == null) throw new Error('the command declares no writes predicate')
  const parsed = parseFlags(argv, specOf(cmd.name), cmd.name, '/data')
  return cmd.writes(parsed.flagKwargs, parsed.paths)
}

async function runCmd(
  reg: readonly RegisteredCommand[],
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]>,
  stdin: Uint8Array | null,
): Promise<{ out: Uint8Array; writes: Record<string, Uint8Array>; exitCode: number }> {
  const cmd = reg[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await cmd.fn(vfs.accessor, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: new Uint8Array(), writes: {}, exitCode: 0 }
  const [output, io] = result as [unknown, { writes: Record<string, Uint8Array>; exitCode: number }]
  let outBytes: Uint8Array = new Uint8Array()
  if (output !== null) {
    outBytes =
      output instanceof Uint8Array ? output : await materialize(output as AsyncIterable<Uint8Array>)
  }
  return { out: outBytes, writes: io.writes, exitCode: io.exitCode }
}

describe('gzip / gunzip', () => {
  it('gzip from stdin produces gzip output', async () => {
    const vfs = new RAMVFS()
    const { out } = await runCmd(RAM_GZIP, vfs, [], {}, ENC.encode('hello world'))
    const decompressed = await gunzipUtil(out)
    expect(DEC.decode(decompressed)).toBe('hello world')
  })

  it('gunzip from stdin decompresses', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzipUtil(ENC.encode('hello world'))
    const { out } = await runCmd(RAM_GUNZIP, vfs, [], {}, compressed)
    expect(DEC.decode(out)).toBe('hello world')
  })

  it('gzip -> gunzip round trip via stdin', async () => {
    const vfs = new RAMVFS()
    const { out: gz } = await runCmd(RAM_GZIP, vfs, [], {}, ENC.encode('roundtrip test'))
    const { out: plain } = await runCmd(RAM_GUNZIP, vfs, [], {}, gz)
    expect(DEC.decode(plain)).toBe('roundtrip test')
  })

  it('gzip on a file writes <path>.gz', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('test content'))
    const { writes } = await runCmd(RAM_GZIP, vfs, [PathSpec.fromStrPath('/f.txt')], {}, null)
    expect(writes['/f.txt.gz']).toBeDefined()
  })

  it('gunzip on a file writes <path> without .gz', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzipUtil(ENC.encode('original data'))
    vfs.store.files.set('/f.txt.gz', compressed)
    const { writes } = await runCmd(RAM_GUNZIP, vfs, [PathSpec.fromStrPath('/f.txt.gz')], {}, null)
    expect(writes['/f.txt']).toBeDefined()
    expect(DEC.decode(writes['/f.txt'])).toBe('original data')
  })
})

describe('gzip and gunzip say which invocations write', () => {
  it.each([
    [[], false],
    [['-d'], false],
    [['-c', 'f.txt'], false],
    [['-dc', 'f.txt.gz'], false],
    [['f.txt'], true],
    [['-k', 'f.txt'], true],
    [['-d', 'f.txt.gz'], true],
  ])('gzip %j writes: %s', (argv, writes) => {
    expect(writesFor(RAM_GZIP[0], argv)).toBe(writes)
  })

  it.each([
    [[], false],
    [['-c', 'f.txt.gz'], false],
    [['-t', 'f.txt.gz'], false],
    [['f.txt.gz'], true],
    [['-k', 'f.txt.gz'], true],
  ])('gunzip %j writes: %s', (argv, writes) => {
    expect(writesFor(RAM_GUNZIP[0], argv)).toBe(writes)
  })
})

describe('gzip on a read-only mount', () => {
  it('runs where it writes nothing and refuses an in-place write', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('hello\n'))
    const ws = new Workspace(
      { '/ro/': [vfs, MountMode.READ] },
      { shellParser: await getTestParser() },
    )
    try {
      const piped = await ws.shell("cd /ro && printf 'x\\n' | gzip | gunzip")
      expect([piped.exitCode, DEC.decode(piped.stdout), DEC.decode(piped.stderr)]).toEqual([
        0,
        'x\n',
        '',
      ])
      const toStdout = await ws.shell('gzip -c /ro/f.txt | gunzip')
      expect([toStdout.exitCode, DEC.decode(toStdout.stdout)]).toEqual([0, 'hello\n'])
      const inPlace = await ws.shell('gzip /ro/f.txt')
      expect(inPlace.exitCode).toBe(1)
      expect(DEC.decode(inPlace.stderr)).toBe('gzip: read-only mount at /ro/\n')
      expect([...vfs.store.files.keys()].sort()).toEqual(['/f.txt'])
    } finally {
      await ws.close()
    }
  })
})
