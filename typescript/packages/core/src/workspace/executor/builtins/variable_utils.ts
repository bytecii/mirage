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
import type { ArithError } from '../../../shell/errors.ts'
import type { PolicyDenied } from '../../../policy/errors.ts'
import type { Session } from '../../session/session.ts'
import { sessionView } from '../../session/state.ts'
import type { SessionView } from '../../../ops/types.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './shared.ts'
import { IDENTIFIER_RE } from './constants.ts'

/**
 * The session view to write through. Production callers thread the
 * workspace's gated view; a direct invocation (a unit test) gets an
 * ungated one over the same session.
 */
export function viewOf(session: Session, state: SessionView | null): SessionView {
  return state ?? sessionView(session)
}

/** Render a policy denial in the builtin's own voice. */
export function doorRefusal(cmd: string, err: PolicyDenied): Result {
  const encoded = new TextEncoder().encode(`${err.message}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

/** Render the shell's own readonly refusal, checked before the door. */
export function readonlyRefusal(cmd: string, name: string): Result {
  const encoded = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

/**
 * Render the `-i` coercion's arithmetic error as bash does.
 *
 * GNU voices it as the evaluator's own line, prefixed by the builtin and
 * the offending text (`bash: read: 1+: syntax error: operand expected`),
 * and fails the builtin with 1 while the variable keeps its old value,
 * which is what the door's copy-then-store already guarantees. A plain
 * assignment (`n=1+`) is fatal instead and is voiced by the executor
 * without a builtin name.
 */
export function arithRefusal(cmd: string, err: ArithError): Result {
  const encoded = new TextEncoder().encode(`bash: ${cmd}: ${err.message}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

export function isShiftCount(word: string): boolean {
  const body = word.startsWith('-') || word.startsWith('+') ? word.slice(1) : word
  return /^\d+$/.test(body)
}

export function isValidName(name: string): boolean {
  return IDENTIFIER_RE.test(name)
}
