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
import { varHidden } from '../../../utils/hidden.ts'
import { sessionEntry } from '../../session/session.ts'
import { attrLetters } from '../../../shell/variable.ts'
import type { Session } from '../../session/session.ts'
import { exportedNames, visibleEnv } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './shared.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { isValidName } from './variable_utils.ts'
import { ANSI_C_ESCAPES, CONTROL_RE, BARE_KEY_RE, SUBSCRIPT_RE } from './constants.ts'

function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code < 0x20 || code === 0x7f
}

/**
 * Quote a value the way bash `declare -p` / `export -p` does.
 *
 * A value holding any control character takes the `$'...'` form, with the
 * named escapes bash uses (`\a \b \t \n \v \f \r`, and `\E` for escape) and
 * three-digit octal for the rest; `"`, `$` and backtick need no escaping
 * there because `$'...'` does not expand. Everything else is double-quoted
 * with escapes for `\`, `"`, `$` and backtick. Non-ASCII printable text
 * stays literal, which is what bash emits in a UTF-8 locale.
 */
function bashDeclareQuote(value: string): string {
  let out = ''
  if (CONTROL_RE.test(value)) {
    for (const ch of value) {
      const escape = ANSI_C_ESCAPES[ch]
      if (escape !== undefined) out += escape
      else if (isControl(ch)) out += `\\${(ch.codePointAt(0) ?? 0).toString(8).padStart(3, '0')}`
      else out += ch
    }
    return `$'${out}'`
  }
  for (const ch of value) {
    if (ch === '\\' || ch === '"' || ch === '$' || ch === '`') out += `\\${ch}`
    else out += ch
  }
  return `"${out}"`
}

export function splitDeclFlags(
  args: string[],
  allowed: Set<string>,
): { flags: Set<string>; names: string[]; bad: string | null } {
  const flags = new Set<string>()
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (tok.startsWith('-') && tok.length > 1 && tok !== '-') {
      const body = tok.slice(1)
      for (const ch of body) {
        if (!allowed.has(ch)) return { flags, names: args.slice(i), bad: ch }
      }
      for (const ch of body) flags.add(ch)
      i += 1
      continue
    }
    break
  }
  return { flags, names: args.slice(i), bad: null }
}

export function exportLines(session: Session, flags: Set<string>): string[] {
  // The exported set, not every shell variable: `X=hello` is absent and
  // `export Y=world` is present, which is what bash prints. -f selects
  // shell functions; mirage tracks no export attribute on functions, so
  // that form lists nothing, as bash does with none exported.
  //
  // Rendering is `declareLine`'s, not a second spelling of it: GNU's
  // `export -p` prints the *whole* cluster, so a readonly exported
  // scalar is `declare -rx R="1"` and an exported array is
  // `declare -ax AR=([0]="a")`. Writing `declare -x` here by hand
  // printed neither, and rendered an exported array as a bare
  // `declare -x AR` because it looked the value up among the scalars.
  if (flags.has('f')) return []
  return exportedNames(session)
    .map((name) => declareLine(session, name))
    .filter((line): line is string => line !== null)
}

/**
 * One associative key as `declare -p` spells it.
 *
 * Bare when every character is one GNU leaves unquoted (pinned by a
 * character sweep on 5.2.37: alphanumerics and `_ % + , - . / : = @ ~`),
 * quoted like a value otherwise. A key that *is* `@` or `*` quotes even
 * though the character is bare mid-key, since the bare spelling would
 * read back as a splat.
 */
function assocKeyText(key: string): string {
  if (key !== '@' && key !== '*' && BARE_KEY_RE.test(key)) return key
  return bashDeclareQuote(key)
}

/**
 * The `=(...)` tail of an associative `declare` line.
 *
 * Sorted keys (mirage's pinned order, where GNU prints hash order) and
 * GNU's trailing space before the closing paren, which an empty map
 * does not carry: `m=([a]="1" )` but `m=()`.
 */
function assocBody(amap: Readonly<Record<string, string>>): string {
  const keys = Object.keys(amap).sort(compareCodePoints)
  if (keys.length === 0) return '=()'
  const parts = keys.map((k) => `[${assocKeyText(k)}]=${bashDeclareQuote(amap[k] ?? '')}`)
  return `=(${parts.join(' ')} )`
}

export function readonlyLines(session: Session, flags: Set<string>): string[] {
  // -a narrows to indexed arrays and -A to associative ones, as bash
  // does. -f selects functions, which mirage carries no readonly
  // attribute for, so that form lists nothing.
  if (flags.has('f')) return []
  const arraysOnly = flags.has('a')
  const assocsOnly = flags.has('A')
  const env = visibleEnv(session)
  const lines: string[] = []
  // A hidden readonly never prints even its bare `declare -r NAME` row.
  for (const name of [...session.readonlyVars]
    .filter((name) => !varHidden(session.hiddenVars, name))
    .sort(compareCodePoints)) {
    const arr = session.arrays[name]
    const amap = session.assocs[name]
    if (arr !== undefined && !assocsOnly) {
      const parts: string[] = []
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]
        if (v !== null && v !== undefined) {
          parts.push(`[${String(i)}]=${bashDeclareQuote(v)}`)
        }
      }
      lines.push(`declare -ar ${name}=(${parts.join(' ')})`)
      continue
    }
    if (amap !== undefined && !arraysOnly) {
      lines.push(`declare -Ar ${name}${assocBody(amap)}`)
      continue
    }
    if (arraysOnly || assocsOnly || arr !== undefined || amap !== undefined) continue
    if (name in env) {
      lines.push(`declare -r ${name}=${bashDeclareQuote(env[name] ?? '')}`)
    } else {
      lines.push(`declare -r ${name}`)
    }
  }
  return lines
}

/**
 * Mark names for export, or print them (`export -p` / bare `export`).
 *
 * With no name operands, prints every entry in `session.env` as
 * `declare -x NAME="value"`. Invalid option characters fail with status 2.
 * Writes go through the session view, so readonly refusal and the
 * preSession policy gate fire here exactly as for any other writer.
 */
/**
 * GNU's `not a valid identifier` line for one declaration operand.
 *
 * A declaration builtin refuses a name it cannot declare rather than
 * storing it: `export 1BAD=x` used to land a variable that `$1BAD` can
 * never name back (bash reads that as `$1` then `BAD`) and then shipped
 * it to every child environment.
 *
 * Which text GNU quotes depends on why the word failed, and both
 * spellings are pinned. A word that is not a valid assignment at all is
 * echoed whole (``export: `1BAD=x'``); a word whose target parses but is
 * not a plain name -- an array element -- is echoed as just that target
 * (``export: `arr[0]'``), since the value it would have taken is not
 * what is wrong with it.
 */
export function identifierRefusal(cmd: string, word: string): string | null {
  const eq = word.indexOf('=')
  const name = eq >= 0 ? word.slice(0, eq) : word
  if (isValidName(name)) return null
  const quoted = SUBSCRIPT_RE.test(name) ? name : word
  return `bash: ${cmd}: \`${quoted}': not a valid identifier`
}

/**
 * Render the refusals collected while declaring names.
 *
 * One line per bad operand, exit 1, and the good operands on the same
 * line are already stored: GNU reports each and keeps going, so
 * `export GOOD=1 1BAD=x GOOD2=2` exports both good names.
 */
export function identifierFailure(cmd: string, errors: string[]): Result {
  const err = new TextEncoder().encode(`${errors.join('\n')}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
  ]
}

/**
 * The `declare -p` line for one name, or null when it has none.
 *
 * The attribute cluster is `attrLetters`, which is why this renders
 * `declare -rx` and `declare -ar` without a table of its own: the record
 * already knows its own letters and their print order. bash spells an
 * empty cluster `--`, and that spelling is the caller's because only a
 * `declare` line needs it.
 *
 * A hidden name answers null, the same way `isReadonly` answers false for
 * one: reporting it as declared would leak it.
 */
export function declareLine(session: Session, name: string): string | null {
  if (varHidden(session.hiddenVars, name)) return null
  const v = sessionEntry(session.vars, name)
  if (v === undefined) return null
  const letters = attrLetters(v)
  const head = letters ? `declare -${letters}` : 'declare --'
  if (v.value === null) return `${head} ${name}`
  if (Array.isArray(v.value)) {
    const parts: string[] = []
    for (let i = 0; i < v.value.length; i++) {
      const el = v.value[i]
      if (el !== null && el !== undefined) {
        parts.push(`[${String(i)}]=${bashDeclareQuote(el)}`)
      }
    }
    return `${head} ${name}=(${parts.join(' ')})`
  }
  if (typeof v.value !== 'string') return `${head} ${name}${assocBody(v.value)}`
  return `${head} ${name}=${bashDeclareQuote(v.value)}`
}
