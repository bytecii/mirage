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

import type { CallStack } from '../../shell/call_stack.ts'
import { type ExecuteFn, expandArith } from '../expand/node.ts'
import { evaluateArith } from '../../shell/arith.ts'
import { ArithError, ReadonlyError } from '../../shell/errors.ts'
import { assignElement } from '../session/elements.ts'
import type { ArithResult, TSNodeLike } from '../../shell/types.ts'
import type { Session } from '../session/session.ts'
import type { SessionView } from '../../ops/types.ts'
import { ensureVarVisible, sessionElements, visibleEnv } from '../session/state.ts'

/**
 * Evaluate one C-style for expression slot: the slot's integer value,
 * or the default for an empty slot (1 for the condition so `for
 * ((;;))` loops, 0 for init/update). Re-raises ArithError with the
 * expression text prepended so the loop can print bash's
 * `((: expr: reason` diagnostic, and throws ReadonlyError when the
 * expression assigns to a readonly variable.
 */
export async function evalCforExpr(
  expr: TSNodeLike | null,
  dflt: number,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<number> {
  if (expr === null) return dflt
  const text = await expandArith(expr, session, executeFn, callStack, view)
  let result: ArithResult
  try {
    // Reads resolve against the visible env so a hidden name counts as
    // unset; a hidden write refuses through the session door
    // (ensureVarVisible), caught by the loop beside ReadonlyError.
    result = evaluateArith(text, visibleEnv(session), 0, sessionElements(session))
  } catch (err) {
    if (!(err instanceof ArithError)) throw err
    throw new ArithError(`${text}: ${err.message}`)
  }
  for (const write of result.writes) {
    ensureVarVisible(session, write.name)
    if (session.readonlyVars.has(write.name)) throw new ReadonlyError(write.name)
  }
  // Through the door, so a preSession rule governs an arithmetic assignment
  // exactly as it governs `X=1`; in evaluation order, so a bare name and
  // its element 0 land as the expression wrote them.
  for (const write of result.writes) {
    await assignElement(session, view ?? null, write.name, write.key, write.value)
  }
  return Number(result.value)
}
