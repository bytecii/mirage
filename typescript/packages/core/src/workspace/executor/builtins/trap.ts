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
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { ExecutionResult } from '../types.ts'
import { TRAP_EXIT_NAMES, TRAP_USAGE } from './constants.ts'

/** EXIT belongs to a virtual shell scope; cancellation is not POSIX signal delivery. */
export function handleTrap(args: readonly string[], session: Session): ExecutionResult {
  const words = [...args]
  let printing = words.length === 0
  if (words[0] === '-p') {
    printing = true
    words.shift()
  } else if (words[0] === '--') {
    words.shift()
    printing = words.length === 0
  } else if (words[0]?.startsWith('-') === true && words[0] !== '-') {
    const err = new TextEncoder().encode(`trap: ${words[0]}: unsupported option\n${TRAP_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'trap', exitCode: 2, stderr: err }),
    ]
  }
  let action: string | null = null
  if (!printing) {
    if (words[0] === '0') action = '-'
    else {
      action = words.shift() ?? null
      if (words.length === 0) {
        const err = new TextEncoder().encode(TRAP_USAGE)
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({ command: 'trap', exitCode: 2, stderr: err }),
        ]
      }
    }
  }
  const errors: string[] = []
  const output: string[] = []
  for (const name of words.length > 0 ? words : ['EXIT']) {
    if (!TRAP_EXIT_NAMES.has(name)) {
      errors.push(`trap: ${name}: unsupported event (supported: EXIT)\n`)
      continue
    }
    if (printing) {
      if (session.exitTrap !== null) {
        const quoted = session.exitTrap.replaceAll("'", "'\\''")
        output.push(`trap -- '${quoted}' EXIT\n`)
      }
    } else {
      session.exitTrap = action === '-' ? null : action
      session.exitTrapInherited = false
    }
  }
  const err = new TextEncoder().encode(errors.join(''))
  const code = errors.length > 0 ? 1 : 0
  return [
    new TextEncoder().encode(output.join('')),
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: 'trap', exitCode: code, stderr: err }),
  ]
}
