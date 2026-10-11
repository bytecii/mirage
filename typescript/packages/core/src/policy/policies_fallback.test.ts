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

import { describe, expect, it, vi } from 'vitest'
import type * as asyncContextModule from '../utils/async_context.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
import type { Policy } from './base.ts'
import type { Action, CommandContext } from './types.ts'

// The browser-runtime branch under node's test runner: no task isolation,
// so a hook cannot run as a policy deciding.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      return new real.FallbackStorage<T>()
    },
  }
})

describe('a hook without task isolation', () => {
  it('reads the session, writes none of it and gets no files', async () => {
    const refused: string[] = []
    let files: unknown = null
    const writer: Policy = {
      async preCommand(ctx: CommandContext): Promise<Action | null> {
        if (ctx.command !== 'echo' || ctx.session === undefined) return null
        files = ctx.vfs
        try {
          await ctx.session.set('TEAM', 'me')
        } catch (err) {
          refused.push((err as { code?: string }).code ?? '')
        }
        return null
      },
    }
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser(), policies: [writer] },
    )
    try {
      await ws.shell('export TEAM=core')
      expect((await ws.shell('echo $TEAM')).stdoutText).toBe('core\n')
      expect(refused).toEqual(['EACCES'])
      expect(files).toBeUndefined()
      expect((await ws.shell('echo $TEAM')).stdoutText).toBe('core\n')
    } finally {
      await ws.close()
    }
  })
})
