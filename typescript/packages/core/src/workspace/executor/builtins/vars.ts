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
import { ArithError, ExitSignal } from '../../../shell/errors.ts'
import { evaluateArith } from '../../../shell/arith.ts'
import type { ArithResult } from '../../../shell/types.ts'
import { PolicyDenied } from '../../../policy/errors.ts'
import {
  arrayExtent,
  arrayUnset,
  buildAssocLiteral,
  buildIndexedLiteral,
  type ShellArray,
} from '../../../shell/array.ts'
import { arrayIndex } from '../../expand/variable.ts'
import { varHidden } from '../../../utils/hidden.ts'
import { sessionEntry, setSessionEntry } from '../../session/session.ts'
import type { ShellValue } from '../../../shell/variable.ts'
import { VarAttr } from '../../../shell/variable.ts'
import { assignElement } from '../../session/elements.ts'
import {
  deref,
  elementIndex,
  ensureVarVisible,
  sessionElements,
  setAttr,
} from '../../session/state.ts'
import type { Session } from '../../session/session.ts'
import { envGet, visibleArrays, visibleAssocs, visibleEnv } from '../../session/state.ts'
import type { SessionView } from '../../../ops/types.ts'
import { ExecutionNode } from '../../types.ts'
import { PRINTF_TARGET_RE } from './text.ts'
import type { Result } from './shared.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import {
  viewOf,
  doorRefusal,
  readonlyRefusal,
  arithRefusal,
  isValidName,
} from './variable_utils.ts'
import {
  EXPORT_USAGE,
  READONLY_USAGE,
  EXPORT_FLAGS,
  READONLY_FLAGS,
  SUBSCRIPT_RE,
} from './constants.ts'
import {
  splitDeclFlags,
  exportLines,
  readonlyLines,
  identifierRefusal,
  identifierFailure,
  declareLine,
} from './variable_format.ts'

/**
 * Put a declaration's value-shaping attributes on a name before its
 * value stores.
 *
 * The door coerces on write by reading the record's attributes, so for
 * the declaration's *own* value to coerce (`declare -i n=3+4` stores
 * `7`), the attribute has to be there first. Gated through `view.mark`
 * like every other mark, and a no-op with nothing to shape, so a plain
 * `declare X=1` costs no extra gate call.
 */
async function premark(
  view: SessionView,
  name: string,
  shaping: ReadonlySet<VarAttr>,
): Promise<void> {
  for (const attr of shaping) await view.mark(name, attr, true)
}

/**
 * Store a declaration's array literals through the session door.
 *
 * The builtin owns the store so a refusal speaks in its own voice:
 * readonly is the shell's rule, checked per name before the door, and
 * the door's gate covers the policy half. Names are processed in
 * order, so an earlier operand stays stored when a later one refuses,
 * as bash does. Returns the refusal result, or null when every
 * literal stored.
 *
 * `mark` is the attribute the declaring keyword puts on each stored
 * name: Readonly for `readonly`, Export for `export`. An attribute
 * rather than a bool because both keywords stage array literals through
 * here and hardcoding one of them silently dropped the other:
 * `export ARR=(a b)` stored the array and never marked it, so GNU's
 * `declare -ax` came out `declare -a`.
 *
 * `stored` is filled with each name that actually stored, in order. A
 * declaration keeps its valid operands when a sibling refuses, so the
 * caller cannot read "what was written" off the aggregate exit status.
 *
 * `on` is the direction of that mark. `export -n ARR=(b)` stores the
 * array and takes the attribute *off*, and the store keeps whatever the
 * name already carried, so leaving the mark unapplied left an exported
 * array exported.
 *
 * A readonly refusal of an array literal is a variable-assignment error
 * in GNU, not a builtin failure: for `export`/`readonly` (and `declare`
 * at top level) `fatal` abandons the rest of the line, while `local`
 * and a function-scoped `declare` refuse in the builtin's voice and the
 * body keeps running (pinned on bash 5.2, debian:stable-slim).
 *
 * `assoc` means the declaration carried `-A`, so every literal builds
 * an associative map; without it a name that already holds one still
 * builds a map, since a plain `m+=([k]=v)` keeps the variable's own
 * kind. `errors` is filled with bash-voiced refusal lines for the
 * plain words a keyed associative literal cannot take; the caller
 * folds them into its exit status, because GNU stores the valid
 * elements and still fails the builtin.
 */
async function storeStagedArrays(
  cmd: string,
  session: Session,
  view: SessionView,
  arrays: { name: string; append: boolean; items: string[] }[],
  mark: VarAttr | null = null,
  on = true,
  fatal = false,
  stored: string[] | null = null,
  assoc = false,
  errors: string[] | null = null,
  shaping: ReadonlySet<VarAttr> = new Set(),
  globalScope = false,
): Promise<Result | null> {
  for (const { name, append, items } of arrays) {
    if (view.isReadonly(name)) {
      if (fatal) {
        const err = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
        throw new ExitSignal(1, err, null, 1)
      }
      return readonlyRefusal(cmd, name)
    }
    if (!globalScope) noteLocalArray(session, name)
    try {
      await premark(view, name, shaping)
    } catch (err) {
      if (err instanceof PolicyDenied) return doorRefusal(cmd, err)
      throw err
    }
    let base: ShellValue
    if (assoc || Object.hasOwn(session.assocs, name)) {
      const { map, badWords } = buildAssocLiteral(session.assocs[name] ?? null, items, append)
      if (errors !== null) {
        for (const word of badWords) {
          errors.push(
            `bash: ${name}: '${word}': must use subscript when assigning associative array`,
          )
        }
      }
      base = map
    } else {
      let held: ShellArray | null = session.arrays[name] ?? null
      if (append && held === null) {
        const scalar = session.env[name]
        held = scalar === undefined ? null : [scalar]
      }
      base = buildIndexedLiteral(held, items, append, (sub) =>
        elementIndex(sub, visibleEnv(session), sessionElements(session)),
      )
    }
    try {
      if (globalScope) await writeGlobal(session, view, name, base)
      else await view.set(name, base)
    } catch (err) {
      if (err instanceof PolicyDenied) return doorRefusal(cmd, err)
      if (err instanceof ArithError) return arithRefusal(cmd, err)
      throw err
    }
    if (stored !== null) stored.push(name)
    // Ungated on purpose: the `view.set` immediately above put this same
    // name through the gate, so re-asking would show a policy two writes
    // for one operand.
    if (mark !== null) setAttr(session, name, mark, on)
  }
  return null
}

/**
 * Run `declare -p`: render declarations for names, or for all.
 *
 * With names, they print in the order given and a name that does not
 * exist is reported on stderr without stopping the rest, exiting 1 at the
 * end -- GNU prints the names it knows and refuses only the ones it does
 * not. Bare `declare -p` lists every visible name sorted.
 */
export function handleDeclarePrint(names: string[], session: Session): Result {
  const targets = names.length > 0 ? names : Object.keys(session.vars).sort(compareCodePoints)
  const lines: string[] = []
  const errors: string[] = []
  for (const name of targets) {
    const line = declareLine(session, name)
    if (line === null) errors.push(`bash: declare: ${name}: not found`)
    else lines.push(line)
  }
  const enc = new TextEncoder()
  const out = lines.length > 0 ? enc.encode(`${lines.join('\n')}\n`) : new Uint8Array()
  const err = errors.length > 0 ? enc.encode(`${errors.join('\n')}\n`) : undefined
  const code = errors.length > 0 ? 1 : 0
  return [
    out,
    new IOResult({ exitCode: code, ...(err !== undefined ? { stderr: err } : {}) }),
    new ExecutionNode({
      command: 'declare',
      exitCode: code,
      ...(err !== undefined ? { stderr: err } : {}),
    }),
  ]
}

export async function handleExport(
  assignments: string[],
  session: Session,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
): Promise<Result> {
  const { flags, names, bad } = splitDeclFlags(assignments, EXPORT_FLAGS)
  if (bad !== null) {
    const err = new TextEncoder().encode(`bash: export: -${bad}: invalid option\n${EXPORT_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'export', exitCode: 2, stderr: err }),
    ]
  }
  if (names.length === 0 && (arrays === null || arrays.length === 0)) {
    const lines = exportLines(session, flags)
    const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
  }
  // -f is accepted and marks nothing: mirage carries no export attribute
  // on functions. -n is the off direction, and applies to both spellings,
  // since `export -n K=v` assigns and unexports.
  const view = viewOf(session, state)
  const on = !flags.has('n')
  if (arrays !== null && arrays.length > 0) {
    // `export ARR=(a b)` marks the array as surely as it marks a scalar:
    // GNU prints `declare -ax ARR=([0]="a" [1]="b")`.
    const refused = await storeStagedArrays(
      'export',
      session,
      view,
      arrays,
      VarAttr.Export,
      on,
      true,
    )
    if (refused !== null) return refused
  }
  const errors: string[] = []
  for (const assign of names) {
    const refusal = identifierRefusal('export', assign)
    if (refusal !== null) {
      errors.push(refusal)
      continue
    }
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (view.isReadonly(key)) return readonlyRefusal('export', key)
      try {
        await view.set(key, assign.slice(eq + 1))
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('export', err)
        throw err
      }
      setAttr(session, key, VarAttr.Export, on)
    } else {
      // The bare form writes no value, so it marks through the plane's
      // no-value door rather than inventing an empty string. On a name
      // that does not exist yet that leaves it *unset and exported*,
      // which is bash's own third state -- `export Z` prints
      // `declare -x Z` and stays out of `env` until something gives it a
      // value. Still gated: marking a hidden or policy-refused name is a
      // session write.
      try {
        await view.mark(assign, VarAttr.Export, on)
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('export', err)
        throw err
      }
    }
  }
  if (errors.length > 0) return identifierFailure('export', errors)
  return [null, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
}

/** The `unset` refusal for a function `readonly -f` froze. */
function readonlyFunctionUnset(name: string): Result {
  const err = new TextEncoder().encode(`bash: unset: ${name}: cannot unset: readonly function\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
  ]
}

/**
 * Run `readonly -f`: freeze the named functions, or list the frozen.
 *
 * A frozen function refuses redefinition and `unset -f` with its own
 * message, exit 1, and the old body stays. A name that is not a
 * function is `not a function`, exit 1, and the other operands still
 * freeze. With no names, lists the frozen functions as `declare -fr
 * NAME`; GNU prints each body first through its own pretty-printer,
 * which mirage does not carry, so the body line is the one deliberate
 * omission.
 */
function readonlyFunctions(session: Session, names: readonly string[]): Result {
  if (names.length === 0) {
    const lines = [...session.readonlyFunctions]
      .filter((name) => name in session.functions)
      .sort(compareCodePoints)
      .map((name) => `declare -fr ${name}`)
    const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
  }
  const errors: string[] = []
  for (const name of names) {
    if (!(name in session.functions)) {
      errors.push(`bash: readonly: ${name}: not a function`)
      continue
    }
    session.readonlyFunctions.add(name)
  }
  if (errors.length > 0) {
    const err = new TextEncoder().encode(`${errors.join('\n')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'readonly', exitCode: 1, stderr: err }),
    ]
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
}

/**
 * Run the function half of `declare`: `-f` / `-F` / `-rf`.
 *
 * `-F NAME` prints the name; `-f NAME` prints `declare -f NAME` where
 * GNU prints the reformatted body (mirage carries no pretty-printer, so
 * the name row is the deliberate stand-in, the same shape `-F` and
 * `readonly -f` list in). A missing name is exit 1 with no message.
 * With `-r` the named functions freeze, as `readonly -f` does. With no
 * names, `-F` lists every function and `-f` lists them the same way.
 */
export function handleDeclareFunctions(
  cmd: string,
  session: Session,
  flags: ReadonlySet<string>,
  names: readonly string[],
): Result {
  if (flags.has('r')) return readonlyFunctions(session, names)
  const targets = names.length > 0 ? names : Object.keys(session.functions).sort(compareCodePoints)
  const lines: string[] = []
  let missing = false
  for (const name of targets) {
    if (!(name in session.functions)) {
      missing = true
      continue
    }
    if (flags.has('F')) lines.push(names.length > 0 ? name : `declare -f ${name}`)
    else lines.push(`declare -f ${name}`)
  }
  const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
  const code = missing ? 1 : 0
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: cmd, exitCode: code }),
  ]
}

/**
 * Mark names readonly, or print them (`readonly -p` / bare `readonly`).
 *
 * With no name operands, prints every readonly name as `declare -r` (or
 * `declare -ar` for arrays). Invalid options fail with status 2.
 */
export async function handleReadonly(
  assignments: string[],
  session: Session,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
  stored: string[] | null = null,
  assoc = false,
  shaping: ReadonlySet<VarAttr> = new Set(),
): Promise<Result> {
  const { flags, names, bad } = splitDeclFlags(assignments, READONLY_FLAGS)
  if (bad !== null) {
    const err = new TextEncoder().encode(
      `bash: readonly: -${bad}: invalid option\n${READONLY_USAGE}`,
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'readonly', exitCode: 2, stderr: err }),
    ]
  }
  if (flags.has('f')) return readonlyFunctions(session, names)
  if (names.length === 0 && (arrays === null || arrays.length === 0)) {
    const lines = readonlyLines(session, flags)
    const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
  }
  const view = viewOf(session, state)
  const errors: string[] = []
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays(
      'readonly',
      session,
      view,
      arrays,
      VarAttr.Readonly,
      true,
      true,
      stored,
      assoc || flags.has('A'),
      errors,
      shaping,
    )
    if (refused !== null) return refused
  }
  for (const assign of names) {
    const refusal = identifierRefusal('readonly', assign)
    if (refusal !== null) {
      errors.push(refusal)
      continue
    }
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (view.isReadonly(key)) return readonlyRefusal('readonly', key)
      try {
        await premark(view, key, shaping)
        await view.set(key, assign.slice(eq + 1))
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('readonly', err)
        if (err instanceof ArithError) return arithRefusal('readonly', err)
        throw err
      }
      // Ungated: the `view.set` above already put this name through the
      // gate, so the mark rides on that decision.
      setAttr(session, key, VarAttr.Readonly)
      if (stored !== null) stored.push(key)
    } else {
      // Gated, exactly as `export NAME` is. The bare form writes no
      // value, so it has no `view.set` to ride on, and marking through
      // `setAttr` walked straight past `preSession`: a deployment
      // refusing `AWS_*` still saw `readonly AWS_KEY` exit 0, create the
      // record, and freeze the name against every later legitimate write.
      try {
        await view.mark(assign, VarAttr.Readonly, true)
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('readonly', err)
        throw err
      }
      if (stored !== null) stored.push(assign)
    }
  }
  if (errors.length > 0) return identifierFailure('readonly', errors)
  return [null, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
}

/**
 * Clear what the env door does not own after a whole-variable unset.
 *
 * The scalar half is the view's (`unset` deleted it, or quietly kept
 * it for a hidden name — a direct delete here would undo that
 * refusal); this clears the array storage and the getopts residue.
 * The array delete keeps a hidden name too: the embedder can seed
 * `session.arrays` before narrowing, so a hidden array exists and is
 * as much the host's to keep as the scalar the view protected.
 */
function unsetVariable(session: Session, name: string): void {
  if (!varHidden(session.hiddenVars, name)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.vars[name]
  }
  if (name === 'OPTIND') session.getoptsOptind = null
}

/**
 * Clear one array element, or a scalar addressed as `base[0]`.
 *
 * Clearing an element keeps the indices of the elements after it, as bash
 * does: it leaves a hole, which neither expands in `${arr[@]}` nor counts
 * toward `${#arr[@]}` but keeps `${arr[i]}` addressing the same values. A
 * subscript on a scalar names element 0 only: `x[0]` unsets the scalar
 * and any other subscript reports `notarray`. A subscript on a name that
 * holds nothing at all is a silent no-op, but on an existing array a
 * negative subscript still below zero after the extent is added reports
 * `subscript`.
 *
 * The element mechanics are the builtin's own, but every landing write
 * still mutates `base`'s session state, so it clears the plane's gate
 * first: for an array base the view's env half is empty, so `view.unset`
 * is exactly the gate, and for a scalar's element 0 it is the whole
 * unset itself. Validation errors write nothing and so never ask.
 */
async function unsetElement(
  session: Session,
  view: SessionView,
  base: string,
  subscript: string,
): Promise<'ok' | 'notarray' | 'subscript'> {
  const amap = sessionEntry(visibleAssocs(session), base)
  if (amap !== undefined) {
    // The subscript is the key, verbatim: `unset "m[1+1]"` removes the
    // key "1+1", and a key that is not there (GNU pins `unset "m[@]"`
    // on an associative array as this same no-op) answers quietly
    // without a write.
    if (!Object.hasOwn(amap, subscript)) return 'ok'
    const next = { ...amap }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete next[subscript]
    await view.set(base, next)
    return 'ok'
  }
  const arr = sessionEntry(visibleArrays(session), base)
  if (arr === undefined) {
    // Visible reads on purpose: a hidden base answers the unset
    // branch's silent no-op instead of a denial that would leak the
    // name's existence.
    if (envGet(session, base) === null) return 'ok'
    if (arrayIndex(subscript, visibleEnv(session)) !== 0) return 'notarray'
    await view.unset(base)
    return 'ok'
  }
  let idx = arrayIndex(subscript, visibleEnv(session))
  if (idx < 0) {
    idx += arrayExtent(arr)
    if (idx < 0) return 'subscript'
  }
  const next = [...arr]
  arrayUnset(next, idx)
  await view.set(base, next)
  return 'ok'
}

/**
 * Unset shell variables, arrays, or functions, with bash's flags.
 *
 * `-v` targets a variable only, `-f` a function only, and a bare name a
 * variable if one exists or else a function. A `name[idx]` operand clears
 * one element; the readonly guard resolves it to the base name first,
 * since that is what `readonly` records. `-n` (unset a nameref itself)
 * has no referent here — mirage has no nameref attribute — so it matches
 * bash on a non-nameref name and leaves it untouched.
 */
export async function handleUnset(
  args: string[],
  session: Session,
  state: SessionView | null = null,
): Promise<Result> {
  let mode: 'auto' | 'v' | 'f' | 'n' = 'auto'
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-') && args[i] !== '-') {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (/^-[vfn]+$/.test(tok)) {
      if (tok.includes('f')) mode = 'f'
      else if (tok.includes('n')) mode = 'n'
      else mode = 'v'
      i += 1
      continue
    }
    const err = new TextEncoder().encode(`bash: unset: ${tok}: invalid option\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'unset', exitCode: 2, stderr: err }),
    ]
  }
  for (const name of args.slice(i)) {
    if (mode === 'n') {
      // `unset -n` drops the reference itself rather than its target;
      // on a plain variable bash unsets it. Ungated-by-target unset.
      try {
        await viewOf(session, state).unset(name, false)
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('unset', err)
        throw err
      }
      continue
    }
    if (mode === 'f') {
      if (session.readonlyFunctions.has(name)) return readonlyFunctionUnset(name)
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.functions[name]
      continue
    }
    const match = PRINTF_TARGET_RE.exec(name)
    const subscript = match?.[2]
    const isElement = subscript !== undefined
    // `readonly arr` records the base name, so an `arr[i]` operand has to
    // be resolved before the guard, as bash does (which also names the
    // base, not the element, in the error).
    const base = match?.[1] ?? name
    if (session.readonlyVars.has(base)) {
      const err = new TextEncoder().encode(
        `bash: unset: ${base}: cannot unset: readonly variable\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
      ]
    }
    const existed =
      isElement || name in session.env || name in session.arrays || name in session.assocs
    // Both spellings clear the preSession gate for the base name: the
    // whole-variable unset through the view's env half, an element
    // unset inside unsetElement, so `unset 'X[0]'` cannot sidestep a
    // policy that vetoes `unset X`.
    let status: 'ok' | 'notarray' | 'subscript'
    try {
      if (subscript !== undefined) {
        status = await unsetElement(session, viewOf(session, state), base, subscript)
      } else {
        await viewOf(session, state).unset(name)
        unsetVariable(session, deref(session, name) || name)
        status = 'ok'
      }
    } catch (err) {
      if (err instanceof PolicyDenied) return doorRefusal('unset', err)
      throw err
    }
    if (status !== 'ok') {
      // bash names the base for "not an array variable" but prints only
      // the bracketed part for a bad subscript.
      const detail =
        status === 'notarray'
          ? `unset: ${base}: not an array variable`
          : `unset: ${name.slice(base.length)}: bad array subscript`
      const err = new TextEncoder().encode(`bash: ${detail}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
      ]
    }
    if (mode === 'auto' && !existed && name in session.functions) {
      if (session.readonlyFunctions.has(name)) return readonlyFunctionUnset(name)
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.functions[name]
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'unset', exitCode: 0 })]
}

/**
 * Record the caller's array before a function shadows `name`.
 *
 * `local -a` / `declare -a` inside a function shadow the caller's array,
 * so the old value (or its absence) has to be remembered for the teardown
 * in `executeCommand`. Returns true when a function scope is active, so
 * the caller should shadow rather than reuse whatever is already there.
 */
export function noteLocalArray(session: Session, name: string): boolean {
  const locals = session.localVars
  if (locals === null) return false
  if (!locals.has(name)) locals.set(name, sessionEntry(session.vars, name) ?? null)
  return true
}

/**
 * Declare names in the running function's scope, or globally.
 *
 * `cmd` is the spelling that reached here: `declare` and `typeset` route
 * through this handler and must say their own name in a diagnostic, not
 * `local`.
 */
/**
 * The line `declare -n NAME=TARGET` earns when TARGET is unusable: bash
 * refuses a target that is not a variable name, a self reference, and
 * (mirage-only) a target spelled as an array element, since the resolver
 * maps names to names.
 */
function namerefRefusal(cmd: string, name: string, target: string): string | null {
  if (SUBSCRIPT_RE.test(target)) {
    return `mirage: ${cmd}: ${target}: name reference to an array element is not supported`
  }
  if (!isValidName(target)) {
    return `bash: ${cmd}: \`${target}': invalid variable name for name reference`
  }
  if (target === name) {
    return `bash: ${cmd}: ${name}: nameref variable self references not allowed`
  }
  return null
}

/**
 * Store a `declare -g` value on the global record. Outside a function,
 * or for a name no frame on the call path shadows, an ordinary write;
 * otherwise the running locals live in `session.vars` and the global
 * record is what the outermost shadowing frame saved, so the write goes
 * through the door with the two swapped for its duration.
 */
async function writeGlobal(
  session: Session,
  view: SessionView,
  key: string,
  value: ShellValue,
): Promise<void> {
  const outer = session.localFrames.find((frame) => frame.has(key))
  if (outer === undefined) {
    await view.set(key, value)
    return
  }
  const shadowing = sessionEntry(session.vars, key)
  const saved = outer.get(key) ?? null
  if (saved === null) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.vars[key]
  } else {
    setSessionEntry(session.vars, key, saved)
  }
  try {
    await view.set(key, value)
    outer.set(key, sessionEntry(session.vars, key) ?? null)
  } finally {
    if (shadowing === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.vars[key]
    } else {
      setSessionEntry(session.vars, key, shadowing)
    }
  }
}

export async function handleLocal(
  assignments: string[],
  session: Session,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
  cmd = 'local',
  stored: string[] | null = null,
  assoc = false,
  shaping: ReadonlySet<VarAttr> = new Set(),
  nameref = false,
  globalScope = false,
): Promise<Result> {
  const locals = globalScope ? null : session.localVars
  if (cmd === 'local' && session.localVars === null) {
    // `local` is the one spelling that needs a function scope;
    // `declare`/`typeset` share this handler and are legal at top level.
    // Without the check the builtin took its operands, stored them
    // globally and exited 0, which is the silent-accept this whole tier
    // exists to remove.
    const err = new TextEncoder().encode('bash: local: can only be used in a function\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
    ]
  }
  const view = viewOf(session, state)
  const errors: string[] = []
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays(
      cmd,
      session,
      view,
      arrays,
      null,
      true,
      locals === null,
      stored,
      assoc,
      errors,
      shaping,
      globalScope,
    )
    if (refused !== null) return refused
  }
  for (const assign of assignments) {
    const refusal = identifierRefusal(cmd, assign)
    if (refusal !== null) {
      errors.push(refusal)
      continue
    }
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      const val = assign.slice(eq + 1)
      if (nameref) {
        const refusal = namerefRefusal(cmd, key, val)
        if (refusal !== null) {
          errors.push(refusal)
          continue
        }
      }
      if (view.isReadonly(key)) return readonlyRefusal(cmd, key)
      if (locals !== null && !locals.has(key)) {
        locals.set(key, sessionEntry(session.vars, key) ?? null)
      }
      try {
        await premark(view, key, shaping)
        if (globalScope) await writeGlobal(session, view, key, val)
        else await view.set(key, val, !nameref)
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal(cmd, err)
        if (err instanceof ArithError) return arithRefusal(cmd, err)
        throw err
      }
      if (stored !== null) stored.push(key)
    } else {
      if (locals !== null && !locals.has(assign)) {
        locals.set(assign, sessionEntry(session.vars, assign) ?? null)
      }
      if (
        envGet(session, assign) === null &&
        !(assign in visibleArrays(session)) &&
        !(assign in visibleAssocs(session))
      ) {
        // A bare declaration of an existing array re-scopes it; a
        // scalar write here would erase it. Visible reads: a hidden
        // name counts as unset, so the write is attempted and the
        // door refuses it.
        if (view.isReadonly(assign)) return readonlyRefusal(cmd, assign)
        try {
          // Declared, not assigned. `local L` leaves the name *unset*,
          // exactly as `export Z` does: GNU prints `declare -- L` and
          // `${L-d}` still expands to `d`. Writing `''` here made both
          // wrong, which is the same invented-empty-string bug the mark
          // door was added to fix for `export`.
          await view.mark(assign, null, true)
        } catch (err) {
          if (err instanceof PolicyDenied) return doorRefusal(cmd, err)
          throw err
        }
      }
      if (stored !== null) stored.push(assign)
    }
  }
  if (errors.length > 0) return identifierFailure(cmd, errors)
  return [null, new IOResult(), new ExecutionNode({ command: cmd, exitCode: 0 })]
}

/**
 * `(( ))` as a builtin: every operand is one expression, the writes land
 * in order, and the status is 1 when the last expression evaluated to 0.
 * No operand is `expression expected`, exit 1; a malformed one aborts
 * the builtin at that word.
 */
export async function handleLet(
  args: string[],
  session: Session,
  state: SessionView | null = null,
): Promise<Result> {
  if (args.length === 0) {
    const err = new TextEncoder().encode('bash: let: expression expected\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'let', exitCode: 1, stderr: err }),
    ]
  }
  const view = viewOf(session, state)
  let value = 0n
  for (const expr of args) {
    let result: ArithResult
    try {
      result = evaluateArith(expr, visibleEnv(session), 0, sessionElements(session))
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      const errBytes = new TextEncoder().encode(`bash: let: ${expr}: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: 'let', exitCode: 1, stderr: errBytes }),
      ]
    }
    for (const write of result.writes) {
      try {
        ensureVarVisible(session, write.name)
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('let', err)
        throw err
      }
      if (view.isReadonly(write.name)) return readonlyRefusal('let', write.name)
    }
    try {
      for (const write of result.writes) {
        await assignElement(session, view, write.name, write.key, write.value)
      }
    } catch (err) {
      if (err instanceof PolicyDenied) return doorRefusal('let', err)
      throw err
    }
    value = result.value
  }
  const code = value !== 0n ? 0 : 1
  return [
    null,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'let', exitCode: code }),
  ]
}
