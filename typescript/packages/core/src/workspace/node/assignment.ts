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
import { NodeType as NT } from '../../shell/types.ts'
import { type ExecuteFn, expandNode } from '../expand/node.ts'
import { ArithError, ExitSignal } from '../../shell/errors.ts'
import { expandAndClassify } from '../expand/parts.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { wordText } from '../../types.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { globOptions, resolveGlobs } from '../expand/globs.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { SessionView } from '../../ops/types.ts'
import { sessionView } from '../session/state.ts'
import { type ShellValue } from '../../shell/variable.ts'
import { SUBSCRIPT_LITERAL_TYPES } from './constants.ts'

/**
 * One assignment through the session door; denial is fatal.
 *
 * Every assignment spelling (scalar, array literal, subscript, append)
 * computes its resulting value and stores through `view.set`, so the
 * gate and the storage invariant live in the door, not here. Denial
 * mirrors the readonly case: a fatal variable-assignment error that
 * abandons the rest of the line.
 */
export async function assignVar(view: SessionView, key: string, value: ShellValue): Promise<void> {
  try {
    await view.set(key, value)
  } catch (err) {
    if (err instanceof PolicyDenied) {
      const denied = new TextEncoder().encode(`${err.message}\n`)
      throw new ExitSignal(1, denied, null, 1)
    }
    if (err instanceof ArithError) {
      // The `-i` coercion refused the text. GNU aborts the line the way
      // a bad subscript does, in the evaluator's voice with the text led.
      throw new ExitSignal(1, new TextEncoder().encode(`bash: ${err.message}\n`), null, 1)
    }
    throw err
  }
}

// Array-literal elements behave like any other shell word list: command
// substitutions word-split and globs resolve to matches
// (`a=($(cmd) /data/*.txt)`), with zero-match globs kept literal.
export async function expandArrayItems(
  arrayNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  callStack: CallStack | null,
): Promise<string[]> {
  const classified = await expandAndClassify(
    arrayNode.namedChildren,
    session,
    executeFn,
    registry,
    session.cwd,
    callStack,
    sessionView(session, registry.policies),
  )
  const resolved = await resolveGlobs(
    classified,
    registry,
    session.shellOptions.noglob === true,
    namespace,
    globOptions(session),
  )
  return resolved.map((w) => wordText(w))
}

/**
 * The expanded subscript text of one `name[...]=` assignment.
 *
 * A purely literal subscript keeps its raw spelling, spaces included
 * (bash stores `m[ k ]` under the key `" k "`); anything carrying an
 * expansion or quoting expands node by node so `m[$k]` and `m["a b"]`
 * resolve with quote removal. The associative path uses the result as
 * the key verbatim; the indexed path evaluates it as arithmetic.
 */
export async function subscriptKeyText(
  subscriptNode: TSNodeLike,
  name: string,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<string> {
  const inner = subscriptNode.namedChildren.filter((sc) => sc.type !== NT.VARIABLE_NAME)
  const raw = subscriptNode.text.slice(name.length + 1, -1)
  if (inner.length === 0 || inner.every((sc) => SUBSCRIPT_LITERAL_TYPES.has(sc.type))) {
    return raw
  }
  const parts: string[] = []
  for (const sc of inner) {
    parts.push(await expandNode(sc, session, executeFn, callStack, view))
  }
  return parts.join('')
}
