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

import { onMount } from '../../test-utils.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize, type PathRecord } from '../../io/types.ts'
import { RAMVFS } from './ram.ts'
import { PathSpec } from '../../types.ts'
const RAM_FIND = GENERIC_COMMANDS.filter((c) => c.name === 'find' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runFind(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  texts: string[] = [],
): Promise<{ lines: string[]; exitCode: number; records: PathRecord[] | null }> {
  const cmd = RAM_FIND[0]
  if (cmd === undefined) throw new Error('find not registered')
  const result = await onMount(vfs, (files) =>
    cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, texts, {
      stdin: null,
      flags,
      vfs: files,
      cwd: PathSpec.fromStrPath('/'),
    }),
  )
  if (result === null) return { lines: [], exitCode: -1, records: null }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  return { lines, exitCode: ioResult.exitCode, records: ioResult.records }
}

describe('find -printf', () => {
  // The action layer renders -printf per row, beside the other actions,
  // so the handler hands back the rows as selected, each naming the start
  // point its %P and %d are measured from; a missing one names none.
  it('hands the rows back unrendered, each under its start point', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/data')
    vfs.store.dirs.add('/data/sub')
    vfs.store.files.set('/data/a.txt', ENC.encode('hello\n'))
    vfs.store.files.set('/data/sub/b.txt', ENC.encode('hi\n'))
    const { lines, records } = await runFind(
      vfs,
      [
        PathSpec.fromStrPath('/data'),
        PathSpec.fromStrPath('/nope'),
        PathSpec.fromStrPath('/data/sub'),
      ],
      {},
      ['-type', 'f', '-printf', '%f %s\\n'],
    )
    expect(lines).toEqual(['/data/a.txt', '/data/sub/b.txt', '/data/sub/b.txt'])
    expect(records?.map((r) => [r.path.virtual, r.run])).toEqual([
      ['/data/a.txt', 0],
      ['/data/sub/b.txt', 0],
      ['/data/sub/b.txt', 2],
    ])
  })
})
