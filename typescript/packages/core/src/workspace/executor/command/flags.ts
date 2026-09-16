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

import {
  occurrencesToKwargs,
  parseCommand,
  parseToKwargs,
} from '../../../commands/spec/parser.ts'
import { oldOptionError, renderOptionError } from '../../../commands/spec/usage.ts'
import type { CommandSpec } from '../../../commands/spec/types.ts'
import type { ParsedCommand } from './types.ts'
import { PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'

// Single-mount dispatch and cross-mount dispatch both parse through here,
// so flags, texts, and parser warnings cannot drift between the two paths
// (a cross-mount `grep --bogus` used to lose its warning). The spec comes
// from the owning mount on the single-mount path and the shared SPECS
// registry on the cross-mount path.
/**
 * A PathSpec for a path the classifier never saw: a relative value
 * cwd-resolved by `parseCommand`, or a spec-classified PATH operand the
 * upstream classifier left as text. `resourcePath` stays empty on
 * purpose: the mount stamps the backend key on every path at execute
 * time (`Mount.executeCmd`), so a parse-time stamp is dead weight —
 * proven in both languages by running the full suite with this field
 * set to a sentinel. Mirrors `synthesize_path_spec` in the Python
 * executor.
 */
function synthesizePathSpec(value: string): PathSpec {
  const slash = value.lastIndexOf('/')
  return new PathSpec({
    resourcePath: '',
    virtual: value,
    directory: slash >= 0 ? value.slice(0, slash + 1) : '/',
    resolved: true,
  })
}

/**
 * The next classified word spelling `value`, in argv order. Two words can
 * resolve to one path (`ls -d dir/ link/` with link -> dir, `tar -C dir .`),
 * each with its own spelling, so every consumer takes the next word for
 * its path off a queue rather than reading a lookup keyed by the path
 * alone, which handed them all the last spelling; the parser hands
 * positionals back in argv order, the guarantee argparse gives too. A path
 * no word spells (one the parser normalized, a followed link whose target
 * climbs through `..`) falls back to the map, which still serves a word
 * the classifier left as text, and is synthesized after that, since a
 * keyed backend cannot read `b/../a`. Mirrors `take_spelling`.
 */
function takeSpelling(
  spellings: Map<string, PathSpec[]>,
  scopeMap: Map<string, PathSpec>,
  value: string,
): PathSpec {
  const taken = spellings.get(rstripSlash(value) || '/')?.shift()
  if (taken !== undefined) return taken
  return scopeMap.get(value) ?? synthesizePathSpec(value)
}

export function parseFlags(
  parts: readonly (string | PathSpec)[],
  spec: CommandSpec | null,
  cmdName: string,
  cwd: string,
  // The session environment, so an option declaring one gets its value
  // from there. Filled inside the parse rather than after it, or an
  // env-supplied int would go unchecked and an env-supplied path would
  // stay a bare string.
  env?: Readonly<Record<string, string>>,
): ParsedCommand {
  const argv: string[] = parts.map((item) => (item instanceof PathSpec ? item.virtual : item))
  const scopeMap = new Map<string, PathSpec>()
  for (const item of parts) {
    if (item instanceof PathSpec) {
      scopeMap.set(item.virtual, item)
      const stripped = rstripSlash(item.virtual)
      if (stripped !== '' && stripped !== item.virtual) scopeMap.set(stripped, item)
    }
  }
  const spellings = new Map<string, PathSpec[]>()
  for (const item of parts) {
    if (item instanceof PathSpec) {
      const key = rstripSlash(item.virtual) || '/'
      const queue = spellings.get(key)
      if (queue === undefined) spellings.set(key, [item])
      else queue.push(item)
    }
  }

  if (spec !== null) {
    const parsed = parseCommand(spec, argv, cwd, env)
    const flagKwargs = parseToKwargs(parsed)

    for (const [key, value] of Object.entries(flagKwargs)) {
      if (typeof value === 'string') {
        const match = scopeMap.get(value)
        if (match !== undefined) {
          flagKwargs[key] = match.virtual
        }
      }
    }
    // An option's value is read before the operands, which is POSIX order
    // and the order -C requires (its value moves the operands after it),
    // so `tar -cf out.tar -C dir .` hands `dir` to -C and `.` to the
    // operand. A flag value stays a string here, so its word only leaves
    // the queue. A permuted line spelling one path twice, once as an
    // option's value typed after the operand, swaps the two spellings and
    // nothing else.
    for (const value of parsed.pathFlagValues) takeSpelling(spellings, scopeMap, value)

    // Classify positional args: each operand takes its own word.
    const paths: PathSpec[] = []
    const texts: string[] = []
    for (const [value, kind] of parsed.args) {
      if (kind === 'path') {
        paths.push(takeSpelling(spellings, scopeMap, value))
      } else {
        texts.push(value)
      }
    }
    return {
      paths,
      texts,
      flagKwargs,
      warnings: parsed.warnings,
      optionErrors: parsed.optionErrors,
      oldOptionNeedsValue: parsed.oldOptionNeedsValue,
      missingRequiredOperands: parsed.missingRequiredOperands,
      typedDests: parsed.typedDests,
      valueOccurrences: occurrencesToKwargs(parsed),
    }
  }

  const paths: PathSpec[] = []
  const texts: string[] = []
  for (const item of parts) {
    if (item instanceof PathSpec) paths.push(item)
    else texts.push(item)
  }
  return {
    paths,
    texts,
    flagKwargs: {},
    warnings: [],
    optionErrors: [],
    oldOptionNeedsValue: null,
    missingRequiredOperands: [],
    typedDests: [],
    valueOccurrences: [],
  }
}

// GNU-shaped refusal for the FIRST option error the parser reported, and
// nothing else: getopt validates each word as it reaches it and the line
// stops at the first refusal, so the answer is positional rather than
// categorical (`tee --output-error=bogus --bogus` names the value and the
// reversed line names the unknown option). The parser appends in scan
// order, which is why there is no precedence table here — the one it
// replaced could only answer in category order and had to special-case
// scan order for two of them.
//
// find is exempt: its expression tokens are validated by
// parseFindExpression, which raises the GNU predicate error itself. Takes
// the whole ParsedCommand, mirroring Python's `option_error(cmd_name, parsed)`.
export function optionError(cmdName: string, parsed: ParsedCommand): [Uint8Array, number] | null {
  if (cmdName === 'find') return null
  // An old-style cluster short of an argument outranks every scan error:
  // tar counts the cluster's needs before argp validates a letter, so
  // `tar Qf` and `tar fQ` both name f, not Q.
  if (parsed.oldOptionNeedsValue !== null) {
    return oldOptionError(cmdName, parsed.oldOptionNeedsValue)
  }
  const error = parsed.optionErrors[0]
  if (error === undefined) return null
  return renderOptionError(cmdName, error)
}
