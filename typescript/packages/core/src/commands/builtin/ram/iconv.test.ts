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
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import type { PathSpec } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { parseFlags } from '../../../workspace/executor/command/flags.ts'
import { specOf } from '../../spec/builtins.ts'
const RAM_ICONV = RAM_COMMANDS.filter((c) => c.name === 'iconv' && c.filetype == null)

const ENC = new TextEncoder()

// What a registered command's writes predicate answers for a typed line,
// read through the same parse the executor hands the mount.
function writesFor(cmd: RegisteredCommand | undefined, argv: string[]): boolean {
  if (cmd?.writes == null) throw new Error('the command declares no writes predicate')
  const parsed = parseFlags(argv, specOf(cmd.name), cmd.name, '/data')
  return cmd.writes(parsed.flagKwargs, parsed.paths)
}

async function runIconv(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: Uint8Array; exitCode: number }> {
  const cmd = RAM_ICONV[0]
  if (cmd === undefined) throw new Error('iconv not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: new Uint8Array(), exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: buf, exitCode: ioResult.exitCode }
}

describe('iconv', () => {
  it('utf-8 to latin-1', async () => {
    const vfs = new RAMVFS()
    const input = ENC.encode('caf\u00e9\n')
    const r = await runIconv(vfs, [], { f: 'utf-8', t: 'latin-1' }, input)
    expect(r.exitCode).toBe(0)
    const expected = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])
    expect(Array.from(r.out)).toEqual(Array.from(expected))
  })
})

describe('iconv says which invocations write', () => {
  it.each([
    [['-f', 'latin1', '-t', 'utf-8'], false],
    [['-f', 'latin1', '-t', 'utf-8', 'in.txt'], false],
    [['-f', 'latin1', '-t', 'utf-8', '-o', 'out.txt', 'in.txt'], true],
  ])('iconv %j writes: %s', (argv, writes) => {
    expect(writesFor(RAM_ICONV[0], argv)).toBe(writes)
  })
})
