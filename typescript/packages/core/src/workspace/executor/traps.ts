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

import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { ExitSignal } from '../../shell/errors.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { ExecuteFn, ExecutionResult } from './types.ts'

/** Await cleanup through the ordinary evaluator before releasing a completed shell's state. */
export async function finishShell(
  executeFn: ExecuteFn | undefined,
  session: Session,
  result: ExecutionResult,
): Promise<ExecutionResult> {
  const [stdout, io, node] = result
  const action = session.exitTrap
  if (
    executeFn === undefined ||
    !action ||
    session.exitTrapInherited ||
    session.runningExitTrap ||
    session.shellOptions.noexec === true
  )
    return result
  const before = await materialize(stdout)
  let code = io.exitCode
  session.lastExitCode = code
  session.runningExitTrap = true
  const depth = session.evalDepth
  session.evalDepth = 1
  try {
    let cleanup: IOResult
    try {
      cleanup = await executeFn(action, { session, sessionId: session.sessionId })
    } catch (err) {
      if (!(err instanceof ExitSignal)) throw err
      code = err.exitCode
      cleanup = new IOResult({ stdout: err.stdout, stderr: err.stderr, exitCode: code })
    }
    const after = await materialize(cleanup.stdout)
    const merged = await io.merge(cleanup)
    merged.exitCode = code
    merged.stdout = concat([before, after])
    node.exitCode = code
    session.lastExitCode = code
    return [merged.stdout, merged, node]
  } finally {
    session.evalDepth = depth
    session.runningExitTrap = false
    // Re-registering during cleanup cannot make this scope exit twice.
    session.exitTrap = null
  }
}

/** Command and input process substitutions own shell state and finish before the parent resumes. */
export async function executeChildShell(
  executeFn: ExecuteFn,
  session: Session,
  script: string,
  stdin: ByteSource | null = null,
): Promise<IOResult> {
  const saved = session.snapshot()
  session.exitTrapInherited = true
  session.runningExitTrap = false
  session.evalDepth = 0
  session.sourceDepth = 0
  try {
    let io = await executeFn(script, { session, sessionId: session.sessionId, stdin })
    ;[, io] = await finishShell(executeFn, session, [
      io.stdout,
      io,
      new ExecutionNode({ command: '$()', exitCode: io.exitCode }),
    ])
    return io
  } finally {
    session.restore(saved)
  }
}
