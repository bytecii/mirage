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
// Mirrors python/tests/commands/builtin/generic/test_gzip.py.

import { describe, expect, it } from 'vitest'
import { MountMode, PathSpec } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { gzipWrites } from './gzip.ts'

async function shell(
  line: string,
  stdin: Uint8Array | null = null,
  seed: Record<string, string> = {},
): Promise<[string, string, number]> {
  const ws = new Workspace(
    { '/data/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    for (const [path, body] of Object.entries(seed)) {
      await ws.shell(`tee ${path} > /dev/null`, { stdin: new TextEncoder().encode(body) })
    }
    const io = await ws.shell(line, { stdin })
    const dec = new TextDecoder()
    return [dec.decode(io.stdout), dec.decode(io.stderr), io.exitCode]
  } finally {
    await ws.close()
  }
}

describe('gzip with a dash operand', () => {
  it('writes the dash to stdout while files compress in place', async () => {
    const r = await shell(
      'cd /data && gzip - a.txt | gzip -dc; ls',
      new TextEncoder().encode('hi\n'),
      {
        '/data/a.txt': 'file\n',
      },
    )
    expect(r).toEqual(['hi\na.txt.gz\n', '', 0])
  })
})

const operand = (raw: string): PathSpec =>
  new PathSpec({ virtual: `/data/${raw}`, directory: '/data/', vfsPath: raw, rawPath: raw })

describe('gzip on a dash operand', () => {
  it('writes nothing, so a read-only mount runs it', async () => {
    // A `-` has no file to replace: gzip compresses stdin to stdout.
    expect(gzipWrites({}, [operand('-')])).toBe(false)
    expect(gzipWrites({}, [operand('-'), operand('f.txt')])).toBe(true)
    const ws = new Workspace(
      { '/ro/': new RAMVFS() },
      { mode: MountMode.READ, shellParser: await getTestParser() },
    )
    try {
      const io = await ws.shell("cd /ro && printf 'x\\n' | gzip - | gunzip -")
      expect([io.exitCode, new TextDecoder().decode(io.stdout)]).toEqual([0, 'x\n'])
    } finally {
      await ws.close()
    }
  })
})

