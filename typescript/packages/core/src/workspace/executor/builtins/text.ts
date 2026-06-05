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

import { interpretEscapes } from '../../../commands/builtin/utils/escapes.ts'
import { IOResult } from '../../../io/types.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'

export function handleEcho(args: string[], nFlag = false, eFlag = false): Result {
  let text = args.join(' ')
  if (eFlag) text = interpretEscapes(text)
  if (!nFlag) text += '\n'
  const out = new TextEncoder().encode(text)
  return [out, new IOResult(), new ExecutionNode({ command: 'echo', exitCode: 0 })]
}

export function handlePrintf(args: string[]): Result {
  if (args.length === 0) {
    return [new Uint8Array(), new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
  }
  let fmt = args[0] ?? ''
  fmt = fmt.replaceAll('\\n', '\n').replaceAll('\\t', '\t')
  let result = fmt
  if (args.length > 1) {
    try {
      result = applyPrintf(fmt, args.slice(1))
    } catch {
      result = fmt
    }
  }
  const out = new TextEncoder().encode(result)
  return [out, new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
}

function applyPrintf(fmt: string, values: string[]): string {
  let argIdx = 0
  return fmt.replace(/%[sd]/g, (match) => {
    const v = values[argIdx++] ?? ''
    if (match === '%s') return v
    const n = Number(v)
    return Number.isFinite(n) ? String(Math.trunc(n)) : v
  })
}

/**
 * `read VAR1 [VAR2 ...]` — read one line from stdin and assign to env vars.
 * Mirrors Python's `mirage.workspace.executor.builtins.handle_read`.
 *
 * Mirrors POSIX behavior:
 *   - Single var: assign whole line.
 *   - Multiple vars: split on whitespace, last var gets the remainder.
 *   - No stdin / EOF: assign all vars to "" and exit 1.
 */
