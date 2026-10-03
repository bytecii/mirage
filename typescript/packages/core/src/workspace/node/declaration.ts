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

import { IOResult } from '../../io/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { SessionView } from '../../ops/types.ts'
import { setAttr } from '../session/state.ts'
import { VarAttr } from '../../shell/variable.ts'
import { ATTR_LETTERS, DECLARE_LETTERS, DECLARE_USAGE } from './constants.ts'
import type { ExecutionResult as Result } from '../executor/types.ts'

/**
 * Fold kind-conversion refusals into a declaration's result.
 *
 * GNU reports `cannot convert indexed to associative array` per refused
 * name on stderr and fails the builtin with 1 while the other operands
 * still declare, so the refusals ride the handler's own result rather
 * than replacing it.
 */
export function mergeConversionErrors(result: Result, errors: readonly string[]): Result {
  if (errors.length === 0) return result
  const [stream, io, node] = result
  const extra = new TextEncoder().encode(errors.join('\n') + '\n')
  const prior = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array(0)
  const merged = new Uint8Array(prior.length + extra.length)
  merged.set(prior, 0)
  merged.set(extra, prior.length)
  const newIo = new IOResult({
    exitCode: 1,
    stderr: merged,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
  })
  return [stream, newIo, new ExecutionNode({ command: node.command, exitCode: 1, stderr: merged })]
}

/**
 * The refusal a `declare` family option cluster earns, if any.
 *
 * An unknown letter is GNU's `invalid option` plus the usage line, exit
 * 2, and it wins over every other check because bash refuses the
 * cluster before it looks at a single operand.
 */
export function declareOptionRefusal(
  cmd: string,
  flagChars: ReadonlySet<string>,
  plusChars: ReadonlySet<string>,
): Result | null {
  const bad = [...flagChars, ...plusChars]
    .sort(compareCodePoints)
    .find((c) => !DECLARE_LETTERS.has(c))
  if (bad === undefined) return null
  const sign = flagChars.has(bad) ? '-' : '+'
  const err = new TextEncoder().encode(
    `bash: ${cmd}: ${sign}${bad}: invalid option\n${DECLARE_USAGE}\n`,
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: 2, stderr: err }),
  ]
}

/**
 * The per-name refusals a `+letter` earns after the operands are known.
 *
 * Two letters cannot be taken off. `+r` on a readonly name is
 * `declare: R: readonly variable`, exit 1, and the name stays frozen.
 * `+a` / `+A` on an array is `cannot destroy array variables in this
 * way`, exit 1, since the kind is what the value is, not a mark. Both
 * are pinned on 5.2.37 and neither stops the other operands from
 * declaring; the first refusal is what the builtin reports.
 */
export function plusRefusals(
  cmd: string,
  session: Session,
  view: SessionView,
  plusChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
): Result | null {
  if (!plusChars.has('r') && !plusChars.has('a') && !plusChars.has('A')) return null
  const names = assignments.map((a) => a.split('=')[0] ?? a)
  for (const { name } of staged ?? []) names.push(name)
  for (const name of names) {
    if (plusChars.has('r') && view.isReadonly(name)) {
      const err = new TextEncoder().encode(`bash: ${cmd}: ${name}: readonly variable\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
      ]
    }
    if (
      (plusChars.has('a') && Object.hasOwn(session.arrays, name)) ||
      (plusChars.has('A') && Object.hasOwn(session.assocs, name))
    ) {
      const err = new TextEncoder().encode(
        `bash: ${cmd}: ${name}: cannot destroy array variables in this way\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
      ]
    }
  }
  return null
}

/**
 * Apply every `-attr` / `+attr` letter to the names a declaration
 * stored, on top of the export stamp.
 *
 * The letters that shape a value (`-i -l -u`) are stored as attributes
 * and applied by the door on every *later* write, which is GNU's rule:
 * `v=MiXeD; declare -l v` keeps `MiXeD`, and the next `v=ABC` stores
 * `abc`. So this stamps and never rewrites. `-l` and `-u` are exclusive:
 * setting one clears the other, and a cluster naming both (`-lu`, `-ul`)
 * sets neither, both pinned on 5.2.37. A `+` letter clears; `+r` is
 * refused earlier on a readonly name and a no-op otherwise, so it is not
 * an off toggle. Through the gated mark door for every name, covered or
 * not: the handler already cleared the gate for these names, so this is
 * one redundant policy call per attribute, and it keeps this stamp out
 * of the ungated-write allowlist that `setAttr` sites must justify.
 */
export async function stampAttrs(
  session: Session,
  view: SessionView,
  flagChars: ReadonlySet<string>,
  plusChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
  stored: readonly string[],
): Promise<Result | null> {
  const refused = await stampExport(session, view, flagChars, assignments, staged, stored)
  if (refused !== null) return refused
  let onAttrs = attrsFor('ilunt', (c) => flagChars.has(c) && !plusChars.has(c))
  if (flagChars.has('l') && flagChars.has('u')) {
    onAttrs = onAttrs.filter((a) => a !== VarAttr.Lower && a !== VarAttr.Upper)
  }
  const offAttrs = attrsFor('iluntx', (c) => plusChars.has(c))
  if (onAttrs.length === 0 && offAttrs.length === 0) return null
  try {
    for (const name of stored) {
      for (const attr of onAttrs) {
        await view.mark(name, attr, true)
        // `-l` displaces `-u` and vice versa; the record keeps one.
        if (attr === VarAttr.Lower) await view.mark(name, VarAttr.Upper, false)
        else if (attr === VarAttr.Upper) await view.mark(name, VarAttr.Lower, false)
      }
      for (const attr of offAttrs) await view.mark(name, attr, false)
    }
  } catch (err) {
    if (!(err instanceof PolicyDenied)) throw err
    const denied = new TextEncoder().encode(`${err.message}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: denied }),
      new ExecutionNode({ command: 'declare', exitCode: 1, stderr: denied }),
    ]
  }
  return null
}

async function stampExport(
  session: Session,
  view: SessionView,
  flagChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
  stored: readonly string[],
): Promise<Result | null> {
  if (!flagChars.has('x')) return null
  const covered = new Set<string>()
  for (const a of assignments) {
    const eq = a.indexOf('=')
    if (eq >= 0) covered.add(a.slice(0, eq))
  }
  for (const { name } of staged ?? []) covered.add(name)
  for (const name of stored) {
    if (covered.has(name)) {
      setAttr(session, name, VarAttr.Export)
      continue
    }
    try {
      await view.mark(name, VarAttr.Export, true)
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const encoded = new TextEncoder().encode(`${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: encoded }),
        new ExecutionNode({ command: 'declare', exitCode: 1, stderr: encoded }),
      ]
    }
  }
  return null
}

/** The attributes the given letters name, in the order given, skipping
 * letters that name none (kinds and modes are not attributes). */
export function attrsFor(letters: string, has: (c: string) => boolean): VarAttr[] {
  const out: VarAttr[] = []
  for (const c of letters) {
    const attr = ATTR_LETTERS.get(c)
    if (attr !== undefined && has(c)) out.push(attr)
  }
  return out
}
