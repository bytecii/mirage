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

import { decodeText } from '../../shell/bytes.ts'
import { compilePosixRegex } from '../../utils/posix.ts'
import { RegexSyntax } from './types.ts'
import { PcreError, hostFlags, matchStart, matchText, translatePcre } from './utils/pcre.ts'
import { RegexError } from '../../rs/errors.ts'
import { LineRegex, type LineSyntax } from '../../rs/regex.ts'
import { wholeLine } from './utils/rust_regex.ts'
import type { HostRegex } from './utils/types.ts'
import { UsageError } from '../errors.ts'
import { materialize } from '../../io/types.ts'
import { PathSpec } from '../../types.ts'
import type { FlagView } from '../spec/flag_view.ts'

export const NEVER_MATCH = '(?!)'

/** A compiled pattern list: -G, -E and -F in mirage-rs, -P in the host's engine. */
export type LineMatcher = RegExp | LineRegex
// The matcher options, as GNU grep names them: each one picks the dialect,
// and two different ones on a line are refused.
const MATCHERS: Readonly<Record<string, RegexSyntax>> = {
  E: RegexSyntax.EXTENDED,
  P: RegexSyntax.PERL,
}
const CONFLICTING_MATCHERS = 'conflicting matchers specified'
const PERL_SINGLE = 'the -P option only supports a single pattern'
// What -w puts around a -P pattern: no word character may touch the match on
// either side (grep 3.11).
const PERL_WORD_BOUNDS: readonly [string, string] = ['(?<!\\w)(?:', ')(?!\\w)']

// Resolve the pattern-list argument from -e values (list[str] when
// multiple) or the positional. Returns the POSIX newline-joined pattern
// list, or null when neither was supplied.
export function patternArg(texts: readonly string[], flags: FlagView): string | null {
  const e = flags.asList('regexp')
  if (e.length > 0) return e.join('\n')
  if (texts.length > 0 && texts[0] !== undefined) return texts[0]
  return null
}

export interface PatternResolution {
  pattern: string | null
  neverMatch: boolean
  error: string | null
}

// Resolve the full pattern list from -e values, the positional, and -f
// pattern files (read via the backend stream). Shared by the grep, rg, and
// zgrep generics. When -f supplies zero patterns the NEVER_MATCH sentinel is
// returned with neverMatch=true (callers must skip -F escaping for it).
export async function resolvePattern(
  name: string,
  texts: readonly string[],
  flags: FlagView,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<PatternResolution> {
  let pattern = patternArg(texts, flags)
  let neverMatch = false
  // `raw` rather than `asList`, mirroring Python's `flags.raw(file_key)`: an
  // empty -f list still means "-f was supplied", which is what turns on the
  // NEVER_MATCH sentinel below.
  const patternFiles = flags.raw('file')
  if (Array.isArray(patternFiles)) {
    for (const file of patternFiles) {
      const patternSpec = PathSpec.fromStrPath(file instanceof PathSpec ? file.virtual : file)
      let fileData: Uint8Array
      try {
        fileData = await materialize(stream(patternSpec))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const shown = file instanceof PathSpec ? file.rawPath : file
        return { pattern: null, neverMatch: false, error: `${name}: ${shown}: ${msg}\n` }
      }
      pattern = mergePatternList(pattern, fileData)
    }
    if (pattern === null) {
      pattern = NEVER_MATCH
      neverMatch = true
    }
  }
  return { pattern, neverMatch, error: null }
}

export function mergePatternList(
  pattern: string | null,
  fileData: Uint8Array | null,
): string | null {
  const parts: string[] = pattern === null ? [] : pattern.split('\n')
  if (fileData !== null && fileData.length > 0) {
    let text = decodeText(fileData)
    if (text.endsWith('\n')) text = text.slice(0, -1)
    parts.push(...text.split('\n'))
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}

/**
 * The dialect grep's matcher options pick, refusing a mixture. GNU grep 3.11
 * keeps one matcher: -G, -E, -F and -P each name one, repeating the same is
 * harmless, and any two different ones are `conflicting matchers specified`
 * (exit 2) in either order. -F is carried as `fixedString`, so it only takes
 * part in the check.
 */
export function matcherSyntax(fl: FlagView, prog = 'grep'): RegexSyntax {
  const dests: Record<string, string> = {
    basic_regexp: 'G',
    extended_regexp: 'E',
    fixed_strings: 'F',
    perl_regexp: 'P',
  }
  const chosen = new Set<string>()
  for (const [dest, matcher] of Object.entries(dests)) if (fl.asBool(dest)) chosen.add(matcher)
  if (chosen.size > 1) throw new UsageError(`${prog}: ${CONFLICTING_MATCHERS}`)
  for (const matcher of chosen) {
    const syntax = MATCHERS[matcher]
    if (syntax !== undefined) return syntax
  }
  return RegexSyntax.BASIC
}

/**
 * GNU grep's compile-time warnings for a pattern list, as stderr. Only an
 * extended expression has any: GNU warns about a repetition operator at the
 * start of an expression (`grep: warning: * at start of expression`), once per
 * occurrence, which is also how GNU reads `(?<=...)`.
 */
export function patternWarnings(matcher: LineMatcher, prog = 'grep'): string {
  if (!(matcher instanceof LineRegex)) return ''
  return matcher.warnings.map((w) => `${prog}: warning: ${w}\n`).join('')
}

/** Whether a pattern list selects one line, given without its terminator. */
export function lineSelected(matcher: LineMatcher, line: string): boolean {
  if (matcher instanceof LineRegex) return matcher.matches(line)
  matcher.lastIndex = 0
  return matcher.test(line)
}

const scanners = new WeakMap<RegExp, RegExp>()

/** What -o prints from one line: each match's start and text. */
export function linePieces(matcher: LineMatcher, line: string): [number, string][] {
  if (matcher instanceof LineRegex)
    return matcher.extents(line).map(([start, end]) => [start, line.slice(start, end)])
  let scanner = scanners.get(matcher)
  if (scanner === undefined) {
    scanner = compilePosixRegex(
      matcher.source,
      matcher.flags.includes('g') ? matcher.flags : matcher.flags + 'g',
    )
    scanners.set(matcher, scanner)
  }
  const out: [number, string][] = []
  scanner.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = scanner.exec(line)) !== null) {
    out.push([matchStart(match), matchText(match)])
    if (match[0] === '') scanner.lastIndex += (line.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1
  }
  return out
}

/**
 * grep -P's one pattern as host source (`u`-flag syntax), or grep's refusal:
 * more than one pattern, or one PCRE2 refuses. -w wraps it the way GNU grep
 * does; `unicode` is UCP classes (a pushed-down rg -P).
 */
export function perlRegex(
  pattern: string,
  ignoreCase: boolean,
  whole: boolean,
  unicode = false,
): HostRegex {
  if (pattern.includes('\n')) throw new UsageError(`grep: ${PERL_SINGLE}`)
  const source = whole ? PERL_WORD_BOUNDS[0] + pattern + PERL_WORD_BOUNDS[1] : pattern
  try {
    return translatePcre(source, unicode, ignoreCase)
  } catch (err) {
    if (err instanceof PcreError) throw new UsageError(`grep: ${err.message}`)
    throw err
  }
}

// A literal as a Rust regex, the way `regex::escape` spells it.
export function rustEscape(text: string): string {
  return text.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, '\\$&')
}

/** grep -P's pattern as the host's matcher; -x outranks -w. */
export function compilePerl(
  pattern: string,
  ignoreCase = false,
  wholeWord = false,
  utf8 = false,
  lineRegexp = false,
): RegExp {
  const translated = perlRegex(pattern, ignoreCase, wholeWord && !lineRegexp)
  const source = lineRegexp ? wholeLine(translated.source, false) : translated.source
  return compilePosixRegex(source, hostFlags(translated.source, translated.ignoreCase), utf8)
}

/**
 * Compile a pattern list into one matcher; `utf8` means the lines are text
 * under a UTF-8 locale. A refusal is GNU grep's wording, and exits 2 as grep
 * does.
 */
export function compilePattern(
  pattern: string,
  ignoreCase = false,
  fixedString = false,
  wholeWord = false,
  syntax = RegexSyntax.EXTENDED,
  utf8 = false,
  lineRegexp = false,
): LineMatcher {
  // GNU grep 3.11: -x overrides -w in either order.
  wholeWord = wholeWord && !lineRegexp
  if (syntax === RegexSyntax.PERL && !fixedString)
    return compilePerl(pattern, ignoreCase, wholeWord, utf8, lineRegexp)
  const kind: LineSyntax = fixedString
    ? 'fixed'
    : syntax === RegexSyntax.BASIC
      ? 'basic'
      : 'extended'
  try {
    return new LineRegex(pattern.split('\n'), kind, ignoreCase, utf8, wholeWord, lineRegexp)
  } catch (err) {
    if (err instanceof RegexError) throw new UsageError(`grep: ${err.message}`)
    throw err
  }
}
