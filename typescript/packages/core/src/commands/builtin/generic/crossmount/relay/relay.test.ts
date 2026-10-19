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

import { expect, it, vi } from 'vitest'
import { IOResult } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import { Cmd, type RunSingle } from '../types.ts'
import { runRelay } from './relay.ts'

it('rejects the wrong relay strategy before dispatch', async () => {
  const dispatch = vi.fn()
  const runSingle = vi.fn()
  await expect(runRelay(Cmd.CAT, [], [], {}, dispatch, runSingle)).rejects.toThrow(
    'Unsupported cross-mount relay command: cat',
  )
  expect(dispatch).not.toHaveBeenCalled()
  expect(runSingle).not.toHaveBeenCalled()
})

it.each(['awk', 'bc'])("resolves one %s run on its first file's mount alone", async (cmd) => {
  // Resolving on every operand would check /b/two against /a/'s backend.
  const runSingle = vi.fn<RunSingle>().mockResolvedValue([null, new IOResult()])
  const scopes = [PathSpec.fromStrPath('/a/one'), PathSpec.fromStrPath('/b/two')]
  await runRelay(cmd, scopes, [], {}, vi.fn(), runSingle)
  expect(runSingle).toHaveBeenCalledTimes(1)
  expect(runSingle.mock.calls[0]?.[4]?.resolveHint).toBe(scopes[0])
})
