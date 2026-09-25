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
import { MountMode, PathSpec } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { UsageError } from '../../errors.ts'
import { rmWithoutOperands, rmWrites } from './rm_cmd.ts'

const DEC = new TextDecoder()

describe('rm with no operand', () => {
  it('does nothing under -f', () => {
    const result = rmWithoutOperands(true)
    expect(result?.[0]).toBeNull()
    expect(result?.[1].exitCode).toBe(0)
  })

  it('is a missing-operand usage error otherwise', () => {
    let caught: unknown = null
    try {
      rmWithoutOperands(false)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).message).toBe(
      "rm: missing operand\nTry 'rm --help' for more information.",
    )
    expect((caught as UsageError).exitCode).toBe(1)
  })

  it('writes only when it has operands', () => {
    expect(rmWrites({ f: true }, [])).toBe(false)
    expect(rmWrites({}, [PathSpec.fromStrPath('/a.txt')])).toBe(true)
  })

  it.each([MountMode.WRITE, MountMode.READ])('answers like GNU on a %s mount', async (mode) => {
    const ws = new Workspace(
      { '/m/': [new RAMVFS(), mode] },
      { shellParser: await getTestParser() },
    )
    try {
      const forced = await ws.shell('cd /m && rm -f')
      expect([forced.exitCode, DEC.decode(forced.stdout), DEC.decode(forced.stderr)]).toEqual([
        0,
        '',
        '',
      ])
      const bare = await ws.shell('cd /m && rm')
      expect(bare.exitCode).toBe(1)
      expect(DEC.decode(bare.stderr)).toBe(
        "rm: missing operand\nTry 'rm --help' for more information.\n",
      )
    } finally {
      await ws.close()
    }
  })
})
