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

import { IOResult, materialize } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { Cmd, type RunSingle } from '../types.ts'
import { runStream } from './stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface Call {
  cmd: string
  flags: Record<string, FlagValue>
}

// Serves bytes for some operands and a cat-voiced failure for others, and
// records what the run over the merged stream was handed. Mirrors
// FetchFailures in test_stream.py.
class Fetches {
  readonly calls: Call[] = []
  finalStdin: Uint8Array | null = null

  constructor(
    private readonly files: Record<string, string>,
    private readonly failures: Record<string, string> = {},
  ) {}

  readonly run: RunSingle = async (cmd, paths, _texts, flags, extra) => {
    this.calls.push({ cmd, flags: { ...flags } })
    const path = paths[0]?.virtual
    if (cmd === 'cat' && path !== undefined) {
      const failure = this.failures[path]
      if (failure !== undefined) {
        return [
          null,
          new IOResult({ exitCode: 1, stderr: ENC.encode(`cat: ${path}: ${failure}\n`) }),
        ]
      }
      return [ENC.encode(this.files[path] ?? ''), new IOResult()]
    }
    const stdin = extra?.stdin ?? null
    this.finalStdin = stdin === null ? null : await materialize(stdin)
    return [ENC.encode('FINAL'), new IOResult()]
  }
}

function scopes(...virtuals: string[]): PathSpec[] {
  return virtuals.map((virtual) => PathSpec.fromStrPath(virtual))
}

function stderrOf(io: IOResult): string {
  return io.stderr === null ? '' : DEC.decode(io.stderr as Uint8Array)
}

describe('runStream for sort', () => {
  it('answers one refusal ranked like the single-mount generic', async () => {
    const fetches = new Fetches(
      {},
      { '/a/dir': 'Is a directory', '/b/missing': 'No such file or directory' },
    )
    const [out, io] = await runStream(Cmd.SORT, scopes('/a/dir', '/b/missing'), [], {}, fetches.run)
    expect(out).toBeNull()
    expect(stderrOf(io)).toBe('sort: cannot read: /b/missing: No such file or directory\n')
    expect(io.exitCode).toBe(2)
    expect(fetches.calls.map((c) => c.cmd)).toEqual(['cat', 'cat'])
  })

  it('reports a directory it could only fail to read', async () => {
    const fetches = new Fetches({ '/b/y': 'a\n' }, { '/a/dir': 'Is a directory' })
    const [, io] = await runStream(Cmd.SORT, scopes('/a/dir', '/b/y'), [], {}, fetches.run)
    expect(stderrOf(io)).toBe('sort: read failed: /a/dir: Is a directory\n')
    expect(io.exitCode).toBe(2)
  })

  it('refuses its own line before fetching anything', async () => {
    const fetches = new Fetches({ '/a/x': 'a\n', '/b/y': 'b\n' })
    const [, extra] = await runStream(
      Cmd.SORT,
      scopes('/a/x', '/b/y'),
      [],
      { C: true },
      fetches.run,
    )
    expect(stderrOf(extra)).toBe("sort: extra operand '/b/y' not allowed with -C\n")
    expect(extra.exitCode).toBe(2)
    const [, key] = await runStream(
      Cmd.SORT,
      scopes('/a/x', '/b/y'),
      [],
      { key: ['0'] },
      fetches.run,
    )
    expect(key.exitCode).toBe(2)
    expect(stderrOf(key)).toContain('invalid field specification')
    expect(fetches.calls).toEqual([])
  })

  it('ends every input before the next begins', async () => {
    const lines = new Fetches({ '/a/x': 'b', '/b/y': 'a\n' })
    await runStream(Cmd.SORT, scopes('/a/x', '/b/y'), [], {}, lines.run)
    expect(DEC.decode(lines.finalStdin ?? new Uint8Array())).toBe('b\na\n')
    const records = new Fetches({ '/a/x': 'b', '/b/y': 'a\0' })
    await runStream(Cmd.SORT, scopes('/a/x', '/b/y'), [], { zero_terminated: true }, records.run)
    expect(DEC.decode(records.finalStdin ?? new Uint8Array())).toBe('b\0a\0')
  })

  it('sorts the merged stream it cannot merge', async () => {
    const fetches = new Fetches({ '/a/x': 'a\nc\n', '/b/y': 'b\n' })
    await runStream(
      Cmd.SORT,
      scopes('/a/x', '/b/y'),
      [],
      { merge: true, unique: true },
      fetches.run,
    )
    expect(fetches.calls.at(-1)?.flags).toEqual({ unique: true })
  })
})
