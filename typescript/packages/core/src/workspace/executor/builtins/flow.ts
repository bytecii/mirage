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

import { IOResult } from '../../../io/types.ts'
import type { CallStack } from '../../../shell/call_stack.ts'
import { ExitSignal } from '../../../shell/errors.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import { ReturnSignal } from '../control.ts'
import type { Result } from './shared.ts'
import { isShiftCount } from './variable_utils.ts'

export function handleReturn(
  args: readonly string[],
  session: Session,
  callStack: CallStack | null = null,
): Result {
  const inFunction = callStack !== null && callStack.depth > 1
  if (!inFunction && session.sourceDepth === 0) {
    // bash prints the diagnostic, sets $? to 2, and carries on with
    // the rest of the line.
    const err = new TextEncoder().encode(
      "return: can only `return' from a function or sourced script\n",
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 2, stderr: err }),
    ]
  }
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    // bash prints the error and the function returns 2.
    throw new ReturnSignal(
      2,
      new TextEncoder().encode(`return: ${first}: numeric argument required\n`),
    )
  }
  if (args.length > 1) {
    const err = new TextEncoder().encode('return: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 1, stderr: err }),
    ]
  }
  // A bare return propagates the status of the last command executed.
  throw new ReturnSignal(
    first !== undefined ? ((Number(first) % 256) + 256) % 256 : session.lastExitCode,
  )
}

/** Exit the shell, with bash's argument checks. */
export function handleExit(args: readonly string[], session: Session): Result {
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    // bash exits with 2 after the diagnostic.
    throw new ExitSignal(2, new TextEncoder().encode(`exit: ${first}: numeric argument required\n`))
  }
  if (args.length > 1) {
    // bash refuses to exit and the command fails with 1.
    const err = new TextEncoder().encode('exit: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'exit', exitCode: 1, stderr: err }),
    ]
  }
  const code = first !== undefined ? Number(first) : session.lastExitCode
  throw new ExitSignal(((code % 256) + 256) % 256)
}
