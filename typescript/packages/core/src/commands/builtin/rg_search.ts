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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { concat } from '../../utils/bytes.ts'
import { closeQuietly, discardStreams } from '../../io/stream.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { decodeText, encodeText } from '../../shell/bytes.ts'
import { byteOffset } from '../../shell/helpers.ts'
import { requiredNeedles } from './grep_prefilter.ts'
import { matchStart, matchText, userGroups } from './utils/pcre.ts'
import type { TypeChange, TypeSelection } from './rg_filetypes.ts'
import type { JsonValue } from '../../types.ts'

// ripgrep's words for a line -M will not print whole (ripgrep 14.1.1).
export const OMITTED_MATCHING = '[Omitted long matching line]'
export const OMITTED_CONTEXT = '[Omitted long context line]'
export const OMITTED_END = ' [... omitted end of long line]'
// What --trim strips: ASCII whitespace, as ripgrep's trim_ascii_prefix.
const ASCII_SPACE = ' \t\n\v\f\r'
const CAP_LETTER = /[0-9A-Za-z_]+/y
const REPETITION = /\{[0-9]*(,[0-9]*)?\}/y
const ALNUM = /^[\p{L}\p{N}]$/u

/**
 * Normalized rg options, mirrored by Python's RgFlags.
 *
 * parseFlags resolves mutually overriding options in command-line order.
 * maxDepth counts children at depth 1. null terminates filenames;
 * nullData selects NUL-delimited records. typeChanges preserves add/clear
 * order; typeSelections pairs each type name with an exclusion bit.
 */
export interface RgFlags {
  ignoreCase: boolean
  smartCase: boolean
  invert: boolean
  wholeWord: boolean
  lineRegexp: boolean
  fixedString: boolean
  lineNumbers: boolean
  column: boolean
  vimgrep: boolean
  byteOffsets: boolean
  onlyMatching: boolean
  replace: string | null
  trim: boolean
  maxColumns: number | null
  maxColumnsPreview: boolean
  null: boolean
  nullData: boolean
  crlf?: boolean
  multiline?: boolean
  multilineDotall?: boolean
  stats?: boolean
  json?: boolean
  searchZip?: boolean
  pre?: string | null
  preGlobs?: readonly string[]
  pathSeparator: string | null
  quiet: boolean
  countOnly: boolean
  countMatches: boolean
  includeZero: boolean
  filesOnly: boolean
  filesWithoutMatch: boolean
  listFiles: boolean
  typeList: boolean
  withFilename: boolean
  noFilename: boolean
  heading: boolean
  passthru: boolean
  maxCount: number | null
  stopOnNonmatch: boolean
  contextAfter: number
  contextBefore: number
  contextSeparator: string | null
  fieldMatchSeparator: string
  fieldContextSeparator: string
  globs: readonly string[]
  iglobs: readonly string[]
  globCaseInsensitive: boolean
  typeChanges: readonly TypeChange[]
  typeSelections: readonly TypeSelection[]
  hidden: boolean
  maxDepth: number | null
  maxFilesize: number | null
  follow: boolean
  oneFileSystem: boolean
  binary: boolean
  sort: string | null
  sortReverse: boolean
  noMessages: boolean
  // The regex engine: `default` (ripgrep's own), `pcre2` or `auto`.
  engine: string
  // Unicode mode for either engine, on unless --no-unicode (or its alias
  // --no-pcre2-unicode) was given last.
  unicode: boolean
  // -j, null when the line left ripgrep to pick.
  threads: number | null
  // -a, which turns binary detection off; `binary` is -a, --binary or -uuu,
  // which also searches the files a walk would skip as binary.
  text: boolean
}

/**
 * Whether the output shows -A/-B/-C context, which also puts the context
 * separator between one file's lines and the next file's. Only printed
 * lines carry it: -c, -l and --files-without-match answer per file. -o
 * keeps it, each line printed as its matches. --passthru prints every line
 * but never separates groups.
 */
export function printsContext(f: RgFlags): boolean {
  if (
    f.countOnly ||
    f.countMatches ||
    f.filesOnly ||
    f.filesWithoutMatch ||
    f.quiet ||
    f.passthru
  ) {
    return false
  }
  return f.contextBefore > 0 || f.contextAfter > 0
}

const GLOBAL = new WeakMap<RegExp, RegExp>()

function globalOf(pat: RegExp): RegExp {
  let found = GLOBAL.get(pat)
  if (found === undefined) {
    found = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g')
    GLOBAL.set(pat, found)
  }
  return found
}

/**
 * Every match on a line in the order Rust's regex iterates them. After an
 * empty match the search resumes one character on, and an empty match where
 * the previous match ended is skipped: `b*` over `abc` is empty, `b`, empty,
 * where a plain `exec` loop also yields the empty match right after `b`.
 */
export function* rustMatches(pat: RegExp, text: string): Generator<RegExpExecArray> {
  const re = globalOf(pat)
  let pos = 0
  let lastEnd = -1
  while (pos <= text.length) {
    re.lastIndex = pos
    const m = re.exec(text)
    if (m === null) return
    const end = m.index + m[0].length
    if (m[0].length === 0 && end === lastEnd) {
      pos = end + 1
      continue
    }
    yield m
    lastEnd = end
    pos = end > m.index ? end : end + 1
  }
}

// The group a `$` names at the start of `rest`, and its length.
function captureRef(rest: string): [string | null, number] {
  if (rest.length <= 1) return [null, 0]
  if (rest[1] === '{') {
    const close = rest.indexOf('}', 2)
    if (close === -1) return [null, 0]
    return [rest.slice(2, close), close + 1]
  }
  CAP_LETTER.lastIndex = 1
  const name = CAP_LETTER.exec(rest)
  if (name === null) return [null, 0]
  return [name[0], 1 + name[0].length]
}

// One group's text for a replacement, empty when there is none. A number
// counts the pattern's own groups, never a `\K` marker's or another synthetic
// group's.
function capture(m: RegExpExecArray, ref: string, pat: RegExp): string {
  if (/^[0-9]+$/.test(ref)) {
    const number = Number(ref)
    if (number === 0) return matchText(m)
    const host = userGroups(pat)[number - 1]
    return host === undefined ? '' : (m[host] ?? '')
  }
  return m.groups?.[ref] ?? ''
}

/**
 * One match's -r replacement, expanded as Rust's `Captures::expand`: `$1`,
 * `${1}`, `$name` and `${name}` name a group, a name being the longest run
 * of `[0-9A-Za-z_]` (so `$1x` is the group `1x`), a group that did not take
 * part is empty, `$$` is `$`, and a `$` no name follows is itself.
 */
export function expand(template: string, m: RegExpExecArray, pat: RegExp): string {
  const out: string[] = []
  let i = 0
  for (;;) {
    const j = template.indexOf('$', i)
    if (j === -1) {
      out.push(template.slice(i))
      return out.join('')
    }
    out.push(template.slice(i, j))
    const rest = template.slice(j)
    if (rest.startsWith('$$')) {
      out.push('$')
      i = j + 2
      continue
    }
    const [ref, length] = captureRef(rest)
    if (ref === null) {
      out.push('$')
      i = j + 1
      continue
    }
    out.push(capture(m, ref, pat))
    i = j + length
  }
}

/**
 * The line with every match replaced, and where each replacement landed in
 * it, which --vimgrep's columns and -M's preview count read.
 */
export function replaceAll(
  pat: RegExp,
  text: string,
  template: string,
): [string, [number, number][]] {
  const pieces: string[] = []
  const spans: [number, number][] = []
  let last = 0
  let length = 0
  for (const m of rustMatches(pat, text)) {
    const before = text.slice(last, matchStart(m))
    pieces.push(before)
    length += before.length
    const replaced = expand(template, m, pat)
    spans.push([length, length + replaced.length])
    pieces.push(replaced)
    length += replaced.length
    last = m.index + m[0].length
  }
  pieces.push(text.slice(last))
  return [pieces.join(''), spans]
}

function charAt(text: string, i: number): string {
  const cp = text.codePointAt(i)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

// The literal a backslash escape at `i` stands for, if any, and where the
// pattern resumes.
function escapeLiteral(pattern: string, i: number): [string | null, number] {
  if (i + 1 >= pattern.length) return [null, pattern.length]
  const nxt = charAt(pattern, i + 1)
  if (nxt === 'p' || nxt === 'P') {
    if (pattern[i + 2] === '{') {
      const close = pattern.indexOf('}', i + 3)
      return [null, close === -1 ? pattern.length : close + 1]
    }
    return [null, i + 3]
  }
  if (nxt === 'x') {
    let digits: string
    let end: number
    if (pattern[i + 2] === '{') {
      const close = pattern.indexOf('}', i + 3)
      digits = close === -1 ? '' : pattern.slice(i + 3, close)
      end = close === -1 ? pattern.length : close + 1
    } else {
      digits = pattern.slice(i + 2, i + 4)
      end = i + 4
    }
    if (!/^[0-9A-Fa-f]+$/.test(digits)) return [null, end]
    const cp = Number.parseInt(digits, 16)
    return [cp <= 0x10ffff ? String.fromCodePoint(cp) : null, end]
  }
  if (ALNUM.test(nxt)) return [null, i + 1 + nxt.length]
  return [nxt, i + 1 + nxt.length]
}

/**
 * The literal characters of one ripgrep pattern, which is all smart case
 * looks at: class members and escaped punctuation count, while escapes like
 * `\w`, repetition counts, group syntax and POSIX class names do not.
 */
function* regexLiterals(pattern: string): Generator<string> {
  let i = 0
  let inClass = false
  while (i < pattern.length) {
    const ch = charAt(pattern, i)
    if (ch === '\\') {
      const [literal, next] = escapeLiteral(pattern, i)
      if (literal !== null) yield literal
      i = next
      continue
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false
        i += 1
      } else if (pattern.startsWith('[:', i)) {
        const close = pattern.indexOf(':]', i + 2)
        i = close === -1 ? i + 1 : close + 2
      } else {
        if (ch !== '-') yield ch
        i += ch.length
      }
      continue
    }
    if (ch === '[') {
      inClass = true
      i += 1
      if (pattern[i] === '^') i += 1
      if (pattern[i] === ']') {
        yield ']'
        i += 1
      }
      continue
    }
    if (pattern.startsWith('(?', i)) {
      let j = i + 2
      if (
        pattern.startsWith('P<', j) ||
        (pattern.startsWith('<', j) && !pattern.startsWith('<=', j) && !pattern.startsWith('<!', j))
      ) {
        const close = pattern.indexOf('>', j)
        i = close === -1 ? pattern.length : close + 1
        continue
      }
      while (j < pattern.length && pattern[j] !== ':' && pattern[j] !== ')') j += 1
      i = j < pattern.length && pattern[j] === ':' ? j + 1 : j
      continue
    }
    if (ch === '{') {
      REPETITION.lastIndex = i
      const rep = REPETITION.exec(pattern)
      if (rep !== null) {
        i += rep[0].length
        continue
      }
    }
    if (!'.^$*+?()|{'.includes(ch)) yield ch
    i += ch.length
  }
}

function isUpper(ch: string): boolean {
  return ch.toLowerCase() !== ch && ch.toUpperCase() === ch
}

/**
 * Whether -S searches `pattern` without regard to case: it has at least one
 * literal character and none of them is uppercase. `fixedString` is -F,
 * where every character is a literal.
 */
export function smartCaseFolds(pattern: string, fixedString: boolean): boolean {
  let found = false
  for (const part of pattern.split('\n')) {
    for (const ch of fixedString ? Array.from(part) : regexLiterals(part)) {
      found = true
      if (isUpper(ch)) return false
    }
  }
  return found
}

function byteLen(text: string): number {
  return encodeText(text).length
}

/**
 * Byte offsets of ever later positions in one line, each counted on from
 * the one before, so a line's matches cost one pass over it rather than one
 * per match.
 */
export class ByteCursor {
  private index = 0
  private offset = 0

  constructor(private readonly text: string) {}

  // The byte offset of an index into the line, no earlier than the last
  // one asked for.
  at(index: number): number {
    this.offset += byteLen(this.text.slice(this.index, index))
    this.index = index
    return this.offset
  }
}

/**
 * What one haystack's search selected, beside what it printed: `binary` when
 * a binary-file notice stood in for the lines, `skipped` when a walked
 * binary file went unsearched, which no listing names but
 * --files-without-match's status counts.
 */
// What one haystack's search selected, beside what it printed. The counts
// are kept for --stats and --json: the matches in the selected lines, the
// selected lines, the bytes read before the search stopped, and a binary
// file's first NUL.
export interface Tally {
  selected: boolean
  binary?: boolean
  skipped?: boolean
  matches?: number
  matchedLines?: number
  searched?: number
  nul?: number | null
}

/** A span of time as ripgrep's JSON writes it, keys sorted for the summary. */
function duration(seconds: number, ordered = false): Record<string, JsonValue> {
  const total = Math.floor(seconds * 1e9)
  const secs = Math.floor(total / 1e9)
  const nanos = total % 1e9
  const human = `${seconds.toFixed(6)}s`
  return ordered ? { human, nanos, secs } : { secs, nanos, human }
}

/** ripgrep's JSON for some text: `text` when it is UTF-8, else base64 bytes. */
export function jsonText(text: string): Record<string, JsonValue> {
  const raw = encodeText(text)
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw) }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    let binary = ''
    for (const byte of raw) binary += String.fromCharCode(byte)
    return { bytes: btoa(binary) }
  }
}

/** One JSON Lines record as ripgrep writes it. */
export function jsonLine(message: JsonValue): Uint8Array {
  return encodeText(JSON.stringify(message) + '\n')
}

/** Count one selected line for --stats and --json. */
function tallyLine(tally: Tally, pat: RegExp, text: string, f: RgFlags): void {
  tally.matchedLines = (tally.matchedLines ?? 0) + 1
  if (!f.invert) tally.matches = (tally.matches ?? 0) + [...rustMatches(pat, text)].length
}

/** What --stats and the --json summary add up over the haystacks. */
export class Totals {
  matches = 0
  matchedLines = 0
  withMatch = 0
  searched = 0
  printed = 0
  bytesSearched = 0
  elapsed = 0

  /** Count one haystack: its tally, the bytes printed for it, its seconds. */
  add(tally: Tally, printed: number, elapsed: number): void {
    this.matches += tally.matches ?? 0
    this.matchedLines += tally.matchedLines ?? 0
    this.withMatch += tally.selected ? 1 : 0
    this.searched += 1
    this.printed += printed
    this.bytesSearched += tally.searched ?? 0
    this.elapsed += elapsed
  }

  /** The --json record that closes one haystack's records. */
  endRecord(name: string, tally: Tally, printed: number, elapsed: number): Uint8Array {
    return jsonLine({
      type: 'end',
      data: {
        path: jsonText(name),
        binary_offset: tally.nul ?? null,
        stats: {
          elapsed: duration(elapsed),
          searches: 1,
          searches_with_match: tally.selected ? 1 : 0,
          bytes_searched: tally.searched ?? 0,
          bytes_printed: printed,
          matched_lines: tally.matchedLines ?? 0,
          matches: tally.matches ?? 0,
        },
      },
    })
  }

  /** The --json record that ends the output. */
  summaryRecord(total: number): Uint8Array {
    return jsonLine({
      data: {
        elapsed_total: duration(total, true),
        stats: {
          bytes_printed: this.printed,
          bytes_searched: this.bytesSearched,
          elapsed: duration(this.elapsed, true),
          matched_lines: this.matchedLines,
          matches: this.matches,
          searches: this.searched,
          searches_with_match: this.withMatch,
        },
      },
      type: 'summary',
    })
  }

  /** What --stats prints after the output. */
  statsBlock(total: number): Uint8Array {
    return encodeText(
      `\n${String(this.matches)} matches\n` +
        `${String(this.matchedLines)} matched lines\n` +
        `${String(this.withMatch)} files contained matches\n` +
        `${String(this.searched)} files searched\n` +
        `${String(this.printed)} bytes printed\n` +
        `${String(this.bytesSearched)} bytes searched\n` +
        `${this.elapsed.toFixed(6)} seconds spent searching\n` +
        `${total.toFixed(6)} seconds\n`,
    )
  }
}

const RG_BUFFER_BYTES = 64 * 1024

/**
 * ripgrep's binary detection over one haystack's bytes.
 *
 * grep-searcher looks for NUL in what it reads, ripgrep 14.1.1 in one of
 * three modes. `quit`, a walked file's: a NUL in the first 64 KiB leaves
 * the whole file unsearched, and one past it ends the search there.
 * `convert`, a file named on the line or any file under --binary: a NUL in
 * the first 64 KiB (all a memory map checks) makes the file binary, its
 * NULs read as line terminators, and a printed match gives way to one
 * notice naming the first NUL's offset. `text`, under -a or --null-data:
 * nothing is looked at. `note`, a named file under --json: the first NUL's
 * offset is kept for the end record, and the file is searched as it is.
 * Mirrors Python's RgBinary.
 */
export class RgBinary {
  offset: number | null = null

  constructor(readonly mode: 'quit' | 'convert' | 'note' | 'text') {}

  /**
   * Whether the file is binary and reads its NULs as terminators, a printed
   * match giving way to the notice.
   */
  get converted(): boolean {
    return this.mode === 'convert' && this.offset !== null
  }

  /**
   * The haystack's bytes, read the way the mode reads them. ripgrep checks
   * what one read returned, at most 64 KiB, before it searches a line of it.
   * `pipe` says the haystack is stdin, whose read returns what has arrived; a
   * file's read fills the buffer.
   */
  async *read(source: AsyncIterable<Uint8Array>, pipe = false): AsyncGenerator<Uint8Array> {
    if (this.mode === 'text') {
      yield* source
      return
    }
    let position = 0
    for await (const block of this.reads(source, pipe)) {
      const at = block.indexOf(0)
      if (at >= 0 && this.mode === 'quit') {
        if (position === 0) this.offset = at
        return
      }
      if (at >= 0 && position === 0) this.offset = at
      position += block.length
      yield this.convertBlock(block)
    }
  }

  /**
   * The reads ripgrep's buffer makes of the haystack. A pipe's read is
   * whatever had arrived, so each served chunk is one, never waited past, and
   * one longer than the buffer is cut into buffers. A file's first read fills
   * the buffer, since the binary decision rests on it, so the chunks a backend
   * serves (8 KiB from disk and S3) are held until it is whole and joined
   * once; later reads take what has arrived, so a search never waits past its
   * answer. A walked file's first buffer grows until it holds a whole line,
   * and a NUL in it ends the read the moment it arrives; a named file's first
   * buffer is all a memory map checks.
   */
  private async *reads(
    source: AsyncIterable<Uint8Array>,
    pipe: boolean,
  ): AsyncGenerator<Uint8Array> {
    let parts: Uint8Array[] = []
    let size = 0
    let newline: number | null = null
    let nul: number | null = null
    let filling = !pipe
    for await (const chunk of source) {
      if (!filling) {
        for (let start = 0; start < chunk.length; start += RG_BUFFER_BYTES) {
          yield chunk.subarray(start, start + RG_BUFFER_BYTES)
        }
        continue
      }
      if (newline === null) {
        const at = chunk.indexOf(0x0a)
        if (at >= 0) newline = size + at
      }
      if (nul === null) {
        const at = chunk.indexOf(0)
        if (at >= 0) nul = size + at
      }
      parts.push(chunk)
      size += chunk.length
      const end = this.firstEnd(newline)
      if (this.mode === 'quit' && nul !== null && (end === null || nul < end)) {
        yield concat(parts)
        return
      }
      if (end === null || size < end) continue
      const held = concat(parts)
      parts = []
      filling = false
      yield held.subarray(0, end)
      for (let start = end; start < held.length; start += RG_BUFFER_BYTES) {
        yield held.subarray(start, start + RG_BUFFER_BYTES)
      }
    }
    if (parts.length > 0) yield concat(parts)
  }

  /**
   * Where the first buffer ends: 64 KiB, or for a walked file the first 64 KiB
   * step past its first newline, null until one came.
   */
  private firstEnd(newline: number | null): number | null {
    if (this.mode !== 'quit') return RG_BUFFER_BYTES
    if (newline === null) return null
    return (Math.floor(newline / RG_BUFFER_BYTES) + 1) * RG_BUFFER_BYTES
  }

  /** Whether a walked file's first buffer held a NUL, so none of it was searched. */
  get skipped(): boolean {
    return this.mode === 'quit' && this.offset !== null
  }

  /** ripgrep's line for a binary file a printed match was found in. */
  notice(label: string | null): Uint8Array {
    const head = label === null ? '' : `${label}: `
    return encodeText(
      `${head}binary file matches (found "\\0" byte around offset ${String(this.offset)})\n`,
    )
  }

  private convertBlock(data: Uint8Array): Uint8Array {
    if (!this.converted) return data
    return data.map((byte) => (byte === 0 ? 0x0a : byte))
  }
}

function lstripAscii(text: string): string {
  let i = 0
  while (i < text.length && ASCII_SPACE.includes(text[i] ?? '')) i += 1
  return text.slice(i)
}

/**
 * How one haystack's selected and context lines print (ripgrep's standard
 * printer): the fields, -o/--vimgrep/-r, --trim and -M. `label` is the path
 * every record leads with, null when the records carry none (a single
 * unlabelled input, or a --heading that already named the file).
 */
/**
 * What ends a line rg writes itself, as opposed to a line it read: NUL under
 * --null-data, CR LF under --crlf.
 */
export function recordEnd(f: RgFlags): string {
  return f.nullData ? '\0' : f.crlf === true ? '\r\n' : '\n'
}

/**
 * One record's text, and whether --crlf took a CR off its end so that `$`,
 * -x and -w see the line without it.
 */
function readLine(raw: Uint8Array, f: RgFlags): [string, boolean] {
  const cr = f.crlf === true && raw[raw.length - 1] === 0x0d
  return [decodeText(cr ? raw.subarray(0, raw.length - 1) : raw), cr]
}

/** One line of a haystack -U searched whole. */
export interface Line {
  // Its byte offset, its index in the decoded haystack, the line with its
  // terminator (and under --crlf its CR) off, and whether --crlf took one.
  readonly start: number
  readonly at: number
  readonly text: string
  readonly cr: boolean
}

/**
 * The lines -U selects for one match: every line it spans, a match whose
 * lines overlap the region's joining it (grep-searcher's multi-line search).
 */
export interface Region {
  first: number
  last: number
  matches: RegExpExecArray[]
}

// The last index whose value is <= `at` (Python's bisect_right less one).
function lineIndex(ats: readonly number[], at: number): number {
  let lo = 0
  let hi = ats.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((ats[mid] ?? 0) <= at) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** A haystack -U searched whole, cut at its line terminators. */
export function splitLines(text: string, f: RgFlags): Line[] {
  const pieces = text.split(f.nullData ? '\0' : '\n')
  if (pieces[pieces.length - 1] === '') pieces.pop()
  const lines: Line[] = []
  let at = 0
  let start = 0
  for (const piece of pieces) {
    const cr = f.crlf === true && piece.endsWith('\r')
    lines.push({ start, at, text: cr ? piece.slice(0, -1) : piece, cr })
    at += piece.length + 1
    start += byteLen(piece) + 1
  }
  return lines
}

/** The regions -U selects, in order. */
export function findRegions(pat: RegExp, text: string, lines: readonly Line[]): Region[] {
  const ats = lines.map((line) => line.at)
  const regions: Region[] = []
  for (const m of rustMatches(pat, text)) {
    const start = matchStart(m)
    if (lines.length === 0 || (start >= text.length && /[\n\0]$/.test(text))) break
    const first = lineIndex(ats, start)
    const last = lineIndex(ats, Math.max(start, m.index + m[0].length - 1))
    const previous = regions[regions.length - 1]
    if (previous !== undefined && previous.last >= first) {
      previous.last = Math.max(previous.last, last)
      previous.matches.push(m)
    } else {
      regions.push({ first, last, matches: [m] })
    }
  }
  return regions
}

export class RgPrinter {
  // ripgrep tracks each match of a line only when something needs it, and
  // -M words its refusal from whether it did.
  private readonly granular: boolean
  // The line the haystack ends on without a terminator, which a --json
  // record shows as it is.
  openLine: number | null = null

  // `name` is the path a --json record names.
  constructor(
    private readonly f: RgFlags,
    private readonly pat: RegExp,
    private readonly label: string | null,
    private readonly name = '',
  ) {
    this.granular = f.column || f.vimgrep || f.replace !== null || f.onlyMatching
  }

  /**
   * One --json match or context record: the lines as they were read, the
   * first one's number and offset, each match's byte span (`spans` are
   * start, end and matched text in `text`). `last` is a -U region's last
   * line.
   */
  jsonRecord(
    kind: string,
    index: number,
    start: number,
    text: string,
    cr: boolean,
    spans: readonly (readonly [number, number, string])[],
    last: number | null = null,
  ): Uint8Array {
    const f = this.f
    const end = (last ?? index) === this.openLine ? '' : f.nullData ? '\0' : '\n'
    return jsonLine({
      type: kind,
      data: {
        path: jsonText(this.name),
        lines: jsonText(text + (cr ? '\r' : '') + end),
        line_number: f.lineNumbers ? index + 1 : null,
        absolute_offset: start,
        submatches: spans.map(([begin, finish, matched]) => ({
          match: jsonText(matched),
          start: byteLen(text.slice(0, begin)),
          end: byteLen(text.slice(0, finish)),
        })),
      },
    })
  }

  // The records one context line prints: the line, or under -o each of its
  // matches (the whole line when it has none).
  // `cr` says --crlf took a CR off the line's end.
  context(index: number, start: number, text: string, cr = false): Uint8Array[] {
    if (this.f.json === true) return [this.jsonRecord('context', index, start, text, cr, [])]
    if (this.f.onlyMatching) {
      return [...this.pieces(index, start, text, [...rustMatches(this.pat, text)], false, cr)]
    }
    return [this.record(index, null, start, text, [], false, true, 0, cr)]
  }

  // The records one selected line prints, one per match under -o and
  // --vimgrep, produced as they are asked for.
  *selected(index: number, start: number, text: string, cr = false): Generator<Uint8Array> {
    const f = this.f
    if (f.json === true) {
      const found = f.invert ? [] : [...rustMatches(this.pat, text)]
      const hits = found.map((m): [number, number, string] => [
        matchStart(m),
        m.index + m[0].length,
        matchText(m),
      ])
      yield this.jsonRecord('match', index, start, text, cr, hits)
      return
    }
    const matches = f.invert || !this.granular ? [] : [...rustMatches(this.pat, text)]
    if (f.onlyMatching) {
      yield* this.pieces(index, start, text, matches, true, cr)
      return
    }
    let shown: string
    let spans: [number, number][]
    let terminated: boolean
    if (f.replace !== null && matches.length > 0) {
      ;[shown, spans] = replaceAll(this.pat, text, f.replace)
      terminated = false
    } else {
      shown = text
      spans = matches.map((m): [number, number] => [matchStart(m), m.index + m[0].length])
      terminated = true
    }
    if (f.vimgrep && matches.length > 0) {
      // One record per match, each at its own column unless --no-column
      // took the columns away.
      const cursor = new ByteCursor(shown)
      for (const [s] of spans) {
        const column = f.column ? 1 + cursor.at(s) : null
        yield this.record(index, column, start, shown, spans, true, terminated, matches.length, cr)
      }
      return
    }
    const first = spans[0]
    const column = f.column && first !== undefined ? 1 + byteOffset(shown, first[0]) : null
    yield this.record(index, column, start, shown, spans, true, terminated, matches.length, cr)
  }

  /**
   * The records one -U region prints, by line: every line it spans, at the
   * column its first match starts; under -o each match's part of each line,
   * at the match's own offset and column; under -r the region once,
   * replaced, a replacement holding a newline printing as one line each;
   * under --vimgrep each match on the line it starts.
   */
  region(region: Region, lines: readonly Line[], text: string): Map<number, Uint8Array[]> {
    const f = this.f
    const ats = lines.map((line) => line.at)
    const records = new Map<number, Uint8Array[]>()
    const offsetOf = (index: number, at: number): number => {
      const line = lines[index]
      return line === undefined ? 0 : line.start + byteLen(text.slice(line.at, at))
    }
    const add = (index: number, record: Uint8Array): void => {
      const list = records.get(index)
      if (list === undefined) records.set(index, [record])
      else list.push(record)
    }
    const replaced = (index: number, column: number | null, shown: string): void => {
      shown.split('\n').forEach((piece, k) => {
        const line = lines[Math.min(index + k, lines.length - 1)]
        add(
          index,
          this.record(index + k, column, line?.start ?? 0, piece, [], true, false, 1, line?.cr),
        )
      })
    }
    const first = lines[region.first]
    const head = region.matches[0]
    if (first === undefined || head === undefined) return records
    const column = f.column ? 1 + offsetOf(region.first, matchStart(head)) - first.start : null
    if (f.json === true) {
      const last = lines[region.last] ?? first
      const moved = region.matches.map((m): [number, number, string] => [
        matchStart(m) - first.at,
        m.index + m[0].length - first.at,
        matchText(m),
      ])
      add(
        region.first,
        this.jsonRecord(
          'match',
          region.first,
          first.start,
          text.slice(first.at, last.at + last.text.length),
          last.cr,
          moved,
          region.last,
        ),
      )
      return records
    }
    if (f.vimgrep && f.replace === null) {
      for (const m of region.matches) {
        const start = matchStart(m)
        const i = lineIndex(ats, start)
        const line = lines[i]
        if (line === undefined) continue
        const at = offsetOf(i, start)
        add(
          i,
          this.record(i, f.column ? 1 + at - line.start : null, line.start, line.text, [], true, true, 1, line.cr),
        )
      }
      return records
    }
    if (f.onlyMatching || f.vimgrep) {
      for (const m of region.matches) {
        const start = matchStart(m)
        const end = m.index + m[0].length
        const i = lineIndex(ats, start)
        const at = offsetOf(i, start)
        const shownColumn = f.column ? 1 + at - (lines[i]?.start ?? 0) : null
        if (f.replace !== null) {
          replaced(i, shownColumn, expand(f.replace, m, this.pat))
          continue
        }
        for (let j = i; j <= lineIndex(ats, Math.max(start, end - 1)); j++) {
          const line = lines[j]
          if (line === undefined) continue
          const piece = text.slice(Math.max(start, line.at), Math.min(end, line.at + line.text.length))
          add(j, this.record(j, shownColumn, at, piece, [[0, piece.length]], true, false, 1, line.cr))
        }
      }
      return records
    }
    if (f.replace !== null) {
      const last = lines[region.last] ?? first
      let shown = ''
      let position = first.at
      for (const m of region.matches) {
        shown += text.slice(position, matchStart(m)) + expand(f.replace, m, this.pat)
        position = Math.max(position, m.index + m[0].length)
      }
      shown += text.slice(position, last.at + last.text.length)
      replaced(region.first, column, shown)
      return records
    }
    for (let i = region.first; i <= region.last; i++) {
      const line = lines[i]
      if (line !== undefined)
        add(i, this.record(i, column, line.start, line.text, [], true, true, 0, line.cr))
    }
    return records
  }

  // -o's records for one line: every match, an empty one included, each at
  // its own offset, or the whole line when nothing in it matches, which is how
  // ripgrep 14.1.1 prints an inverted selection and a context line under -o.
  private *pieces(
    index: number,
    start: number,
    text: string,
    matches: readonly RegExpExecArray[],
    isMatch: boolean,
    cr: boolean,
  ): Generator<Uint8Array> {
    const f = this.f
    if (matches.length === 0) {
      yield this.record(index, null, start, text, [], isMatch, true, 0, cr)
      return
    }
    const cursor = new ByteCursor(text)
    for (const m of matches) {
      let piece = matchText(m)
      if (f.replace !== null && isMatch) piece = expand(f.replace, m, this.pat)
      const offset = cursor.at(matchStart(m))
      const column = f.column && isMatch ? 1 + offset : null
      yield this.record(
        index,
        column,
        start + offset,
        piece,
        [[0, piece.length]],
        isMatch,
        false,
        1,
      )
    }
  }

  // One printed record. `terminated` says whether ripgrep's -M counts the
  // line's terminator in its length (a plain line does, a replaced line and
  // a -o match do not); `count` is the line's match count -M reports. A line
  // printed as it was read ends as it did (`cr`: --crlf took a CR off it);
  // every other record ends as `recordEnd` says.
  private record(
    index: number,
    column: number | null,
    offset: number,
    text: string,
    spans: readonly (readonly [number, number])[],
    isMatch: boolean,
    terminated: boolean,
    count: number,
    cr = false,
  ): Uint8Array {
    const f = this.f
    const sep = isMatch ? f.fieldMatchSeparator : f.fieldContextSeparator
    let head = ''
    if (this.label !== null) head = this.label + (f.null ? '\0' : sep)
    if (f.lineNumbers) head += `${String(index + 1)}${sep}`
    if (column !== null) head += `${String(column)}${sep}`
    if (f.byteOffsets) head += `${String(offset)}${sep}`
    let body = text
    let kept = spans
    if (f.trim) {
      body = lstripAscii(text)
      const cut = text.length - body.length
      kept = spans.filter(([s]) => s >= cut).map(([s, e]): [number, number] => [s - cut, e - cut])
    }
    if (f.maxColumns !== null && f.maxColumns > 0) {
      if (byteLen(body) + (terminated ? 1 : 0) > f.maxColumns) {
        body = this.exceeded(body, kept, isMatch, count)
        terminated = false
      }
    }
    const end = f.crlf === true && terminated && !cr ? '\n' : recordEnd(f)
    return encodeText(`${head}${body}${end}`)
  }

  // What -M prints for a line longer than its limit.
  private exceeded(
    body: string,
    spans: readonly (readonly [number, number])[],
    isMatch: boolean,
    count: number,
  ): string {
    const f = this.f
    const limit = f.maxColumns ?? 0
    const granular = this.granular && isMatch && spans.length > 0
    if (f.maxColumnsPreview) {
      // Code points, like Python's slice.
      const shown = Array.from(body).slice(0, limit).join('')
      if (!granular) return shown + OMITTED_END
      const remaining = spans.filter(([s]) => shown.length <= s && s < body.length).length
      const noun = remaining === 1 ? 'match' : 'matches'
      return `${shown} [... ${String(remaining)} more ${noun}]`
    }
    if (!granular || f.onlyMatching) return isMatch ? OMITTED_MATCHING : OMITTED_CONTEXT
    return `[Omitted long line with ${String(count)} matches]`
  }
}

function selects(pat: RegExp, text: string, invert: boolean): boolean {
  return pat.test(text) !== invert
}

/**
 * Where --stop-on-nonmatch ends a file: at the first unselected line after
 * a selected one. ripgrep's fast inverted search is one line late: the
 * pattern line that ends the first run of selected lines is passed over,
 * unprinted, and the stop comes at the next unselected line. That is how it
 * reads a file it names (through a memory map); a buffered read of stdin
 * stops at that first pattern line instead, which is not reproduced.
 * --passthru reads line by line and is never late.
 */
export class NonmatchStop {
  armed = false
  private seen = false

  constructor(
    private readonly enabled: boolean,
    private readonly late: boolean,
  ) {}

  // Record a selected line.
  select(): void {
    this.seen = true
    if (this.enabled && !this.late) this.armed = true
  }

  // Whether this unselected line is the one a late stop passes over, which
  // arms it.
  passesOver(): boolean {
    if (this.enabled && this.late && this.seen && !this.armed) {
      this.armed = true
      return true
    }
    return false
  }
}

// The --stop-on-nonmatch state for one haystack.
export function nonmatchStop(f: RgFlags): NonmatchStop {
  return new NonmatchStop(f.stopOnNonmatch, f.invert && !f.passthru)
}

// The needles a record must hold to be selected, or null when every record
// is read: -v, --stop-on-nonmatch, --passthru and printed context print or
// stop at a record that holds none.
function recordNeedles(pat: RegExp, f: RgFlags): string[] | null {
  return f.invert || f.stopOnNonmatch || f.passthru || printsContext(f)
    ? null
    : requiredNeedles(pat)
}

// Skip the buffered records before the next one that could be selected;
// returns the records and bytes passed over.
function skipRecords(
  lines: AsyncLineIterator,
  needles: string[] | null,
  pat: RegExp,
  f: RgFlags,
): [number, number] {
  if (needles === null) return [0, 0]
  return lines.skipNonmatchingLines(needles, pat.ignoreCase, f.nullData ? 0 : 0x0a)
}

// The next record and whether a terminator ended it, which only --json
// prints, so the line reader's quicker path serves the rest.
async function readRecord(
  lines: AsyncLineIterator,
  f: RgFlags,
  signal?: AbortSignal,
): Promise<[Uint8Array, boolean] | null> {
  if (!f.nullData && f.json !== true) {
    const raw = await lines.readline(signal)
    return raw === null ? null : [raw, true]
  }
  const [raw, terminated] = await lines.readUntil(f.nullData ? 0 : 0x0a, signal)
  return terminated || raw.length > 0 ? [raw, terminated] : null
}

// Read no further than the first selected line (-q, -l and
// --files-without-match need only that one bit).
async function listing(
  lines: AsyncLineIterator,
  pat: RegExp,
  f: RgFlags,
  tally: Tally,
  signal?: AbortSignal,
): Promise<void> {
  const needles = recordNeedles(pat, f)
  for (;;) {
    skipRecords(lines, needles, pat, f)
    const record = await readRecord(lines, f, signal)
    if (record === null) break
    const [text] = readLine(record[0], f)
    if (selects(pat, text, f.invert)) {
      tally.selected = true
      // --stats and --json count every selected line.
      if (f.stats !== true && f.json !== true) return
      tallyLine(tally, pat, text, f)
    }
  }
}

// -c's selected lines, or --count-matches' matches, up to -m.
async function count(
  lines: AsyncLineIterator,
  pat: RegExp,
  f: RgFlags,
  tally: Tally,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0
  let selected = 0
  const stop = nonmatchStop(f)
  const needles = recordNeedles(pat, f)
  for (;;) {
    skipRecords(lines, needles, pat, f)
    const record = await readRecord(lines, f, signal)
    if (record === null) break
    const [text] = readLine(record[0], f)
    if (!selects(pat, text, f.invert)) {
      if (stop.armed) break
      stop.passesOver()
      continue
    }
    stop.select()
    selected += 1
    tally.selected = true
    tallyLine(tally, pat, text, f)
    if (f.onlyMatching && f.countOnly) {
      // -o -c counts matches, which an inverted selection has none of, and
      // still lists the input (ripgrep 14.1.1).
      if (!f.invert) total += [...rustMatches(pat, text)].length
    } else if (f.countMatches && !f.invert) {
      total += [...rustMatches(pat, text)].length
    } else {
      total += 1
    }
    if (f.maxCount !== null && selected >= f.maxCount) break
  }
  return total
}

/**
 * The printed lines of one haystack, context and all. Selected lines and
 * their context, grouped the way ripgrep groups them, with the context
 * separator between groups. It holds only the last -B lines nothing has
 * printed yet, and stops reading once -m has selected its last line and
 * that line's trailing context is out; a trailing line that would be
 * selected prints as selected, still counted as context. --passthru prints
 * every line up to the -m-th selected one and separates nothing.
 * --stop-on-nonmatch ends the file where `NonmatchStop` says.
 */
async function* printedLines(
  lines: AsyncLineIterator,
  printer: RgPrinter,
  pat: RegExp,
  f: RgFlags,
  tally: Tally,
  binary: RgBinary,
  label: string | null,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const context = printsContext(f)
  const keep = context ? f.contextBefore : 0
  const held: [number, number, string, boolean][] = []
  const budget = new YieldBudget(signal)
  let index = -1
  let position = 0
  let selected = 0
  let lastPrinted = -1
  let afterLeft = 0
  const stop = nonmatchStop(f)
  const needles = recordNeedles(pat, f)
  const counts = f.stats === true || f.json === true
  for (;;) {
    const [skipped, bytes] = skipRecords(lines, needles, pat, f)
    index += skipped
    position += bytes
    const record = await readRecord(lines, f, signal)
    if (record === null) break
    const [raw, terminated] = record
    index += 1
    const start = position
    position += raw.byteLength + 1
    const [text, cr] = readLine(raw, f)
    if (!terminated) printer.openLine = index
    const hit = selects(pat, text, f.invert)
    if (binary.converted) {
      // A binary file prints its notice at the first selected line and
      // nothing else.
      if (!hit) continue
      tally.selected = true
      tally.binary = true
      if (counts) tallyLine(tally, pat, text, f)
      yield binary.notice(label)
      return
    }
    if (!hit && stop.armed) {
      // The line that stops the file still prints as the context it is.
      if (f.passthru || afterLeft > 0) yield* printer.context(index, start, text, cr)
      return
    }
    if (!hit && stop.passesOver()) {
      if (keep > 0) {
        held.push([index, start, text, cr])
        if (held.length > keep) held.shift()
      }
      continue
    }
    const selecting = f.maxCount === null || selected < f.maxCount
    let records: Iterable<Uint8Array> = []
    if (hit && selecting) {
      stop.select()
      selected += 1
      tally.selected = true
      if (counts) tallyLine(tally, pat, text, f)
      if (context) {
        const first = held[0]?.[0] ?? index
        if (lastPrinted >= 0 && first > lastPrinted + 1 && f.contextSeparator !== null) {
          yield encodeText(f.contextSeparator + recordEnd(f))
        }
        for (const [i, s, t, c] of held) yield* printer.context(i, s, t, c)
        held.length = 0
        afterLeft = f.contextAfter
      }
      records = printer.selected(index, start, text, cr)
      lastPrinted = index
    } else if (f.passthru) {
      if (!selecting) return
      records = printer.context(index, start, text, cr)
      lastPrinted = index
    } else if (afterLeft > 0) {
      records = hit
        ? printer.selected(index, start, text, cr)
        : printer.context(index, start, text, cr)
      afterLeft -= 1
      lastPrinted = index
    } else if (keep > 0) {
      held.push([index, start, text, cr])
      if (held.length > keep) held.shift()
    }
    for (const chunk of records) {
      yield chunk
      await budget.run()
    }
    await budget.run()
    if (f.maxCount !== null && selected >= f.maxCount && afterLeft === 0) return
  }
}

/** The name -l or --files-without-match prints for a haystack, if any. */
function* listed(name: string, f: RgFlags, tally: Tally): Generator<Uint8Array> {
  if (!f.quiet && tally.selected === f.filesOnly) {
    yield encodeText(name + (f.null ? '\0' : recordEnd(f)))
  }
}

/** The count -c or --count-matches prints for a haystack, if any. */
function* counted(
  total: number,
  label: string | null,
  f: RgFlags,
  tally: Tally,
): Generator<Uint8Array> {
  if (tally.selected || f.includeZero) {
    const head = label === null ? '' : label + (f.null ? '\0' : ':')
    yield encodeText(`${head}${String(total)}${recordEnd(f)}`)
  }
}

/**
 * One haystack as -U searches it: read whole and matched across its lines,
 * each region a unit for -c and -m (ripgrep 14.1.1). -v selects the lines no
 * region spans; ripgrep counts nothing then. Context and --passthru print
 * around the selected lines as they do line by line, and a line after -m's
 * last unit that a later unit would select prints as selected and then again
 * as context. Mirrors Python's `_multiline`.
 */
async function* multiline(
  reader: AsyncIterable<Uint8Array>,
  pat: RegExp,
  f: RgFlags,
  name: string,
  label: string | null,
  tally: Tally,
  binary: RgBinary,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const chunk of reader) parts.push(chunk)
  tally.searched = parts.reduce((sum, part) => sum + part.length, 0)
  if (binary.skipped) {
    tally.skipped = true
    return
  }
  const text = decodeText(concat(parts))
  const lines = splitLines(text, f)
  const regions = findRegions(pat, text, lines)
  const spanned = new Set<number>()
  for (const r of regions) for (let i = r.first; i <= r.last; i++) spanned.add(i)
  const units: Region[] = f.invert
    ? lines.flatMap((_, i) => (spanned.has(i) ? [] : [{ first: i, last: i, matches: [] }]))
    : regions
  const kept = f.maxCount === null ? units : units.slice(0, f.maxCount)
  tally.selected = kept.length > 0
  tally.matchedLines = kept.reduce((sum, r) => sum + r.last - r.first + 1, 0)
  tally.matches = kept.reduce((sum, r) => sum + r.matches.length, 0)
  if (f.quiet || f.filesOnly || f.filesWithoutMatch) {
    yield* listed(name, f, tally)
    return
  }
  if (f.countOnly || f.countMatches) {
    if (f.invert) {
      tally.selected = false
      return
    }
    const matches = f.countMatches || f.onlyMatching
    const total = kept.reduce((sum, r) => sum + (matches ? r.matches.length : 1), 0)
    yield* counted(total, label, f, tally)
    return
  }
  if (kept.length === 0) return
  if (binary.converted) {
    tally.binary = true
    yield binary.notice(label)
    return
  }
  const printer = new RgPrinter(f, pat, f.heading ? null : label, name)
  if (text !== '' && !text.endsWith(f.nullData ? '\0' : '\n')) printer.openLine = lines.length - 1
  const records = (chosen: readonly Region[]): Map<number, Uint8Array[]> => {
    const out = new Map<number, Uint8Array[]>()
    for (const r of chosen) {
      for (let i = r.first; i <= r.last; i++) if (!out.has(i)) out.set(i, [])
      const line = lines[r.first]
      if (f.invert && line !== undefined) {
        out.set(r.first, [...printer.selected(r.first, line.start, line.text, line.cr)])
        continue
      }
      for (const [i, chunks] of printer.region(r, lines, text)) out.get(i)?.push(...chunks)
    }
    return out
  }
  const picked = records(kept)
  const extra = f.contextAfter > 0 ? records(units.slice(kept.length)) : new Map()
  const end = f.maxCount === null ? null : (kept[kept.length - 1]?.last ?? null)
  const context = printsContext(f)
  const keep = context ? f.contextBefore : 0
  const held: number[] = []
  const budget = new YieldBudget(signal)
  let lastPrinted = -1
  let afterLeft = 0
  for (const [i, line] of lines.entries()) {
    if (end !== null && i > end && (afterLeft === 0 || f.passthru)) return
    let chunks: Iterable<Uint8Array> = []
    const chosen = picked.get(i)
    if (chosen !== undefined) {
      if (context) {
        const first = held[0] ?? i
        if (lastPrinted >= 0 && first > lastPrinted + 1 && f.contextSeparator !== null) {
          yield encodeText(f.contextSeparator + recordEnd(f))
        }
        for (const h of held) {
          const hl = lines[h]
          if (hl !== undefined) yield* printer.context(h, hl.start, hl.text, hl.cr)
        }
        held.length = 0
        afterLeft = f.contextAfter
      }
      chunks = chosen
      lastPrinted = i
    } else if (f.passthru || afterLeft > 0) {
      chunks = [
        ...((extra.get(i) as Uint8Array[] | undefined) ?? []),
        ...printer.context(i, line.start, line.text, line.cr),
      ]
      afterLeft = Math.max(afterLeft - 1, 0)
      lastPrinted = i
    } else if (keep > 0) {
      held.push(i)
      if (held.length > keep) held.shift()
    }
    yield* chunks
    const pending = budget.run()
    if (pending !== undefined) await pending
  }
}

/**
 * One haystack's output as ripgrep prints it, read no further than the
 * answer needs: -q, -l and --files-without-match stop at the first selected
 * line, and -m at its last one and that line's trailing context, so a pipe
 * that goes on past the answer is never waited on. `name` is the haystack's
 * path as printed, which -l and --files-without-match answer with; `label`
 * is the path each record leads with, null when the output names no file;
 * `named` says it was named on the line (or is stdin), which ripgrep
 * searches past a NUL where a walked file is skipped; `pipe` says it is
 * stdin, read as it arrives. Whatever stops the search closes the haystack's
 * reader.
 */
export async function* searchHaystack(
  source: AsyncIterable<Uint8Array>,
  pat: RegExp,
  f: RgFlags,
  name: string,
  label: string | null,
  tally: Tally,
  signal?: AbortSignal,
  named = true,
  pipe = false,
): AsyncGenerator<Uint8Array> {
  // ripgrep selects no line at all under -m0 and prints nothing, count and
  // listing included.
  if (f.maxCount === 0) {
    await closeQuietly(source)
    return
  }
  const binary = new RgBinary(
    f.text || f.nullData
      ? 'text'
      : f.json === true && (named || f.binary)
        ? 'note'
        : named || f.binary
          ? 'convert'
          : 'quit',
  )
  const reader = binary.read(source, pipe)
  const lines = new AsyncLineIterator(reader)
  try {
    if (f.multiline === true) {
      yield* multiline(reader, pat, f, name, label, tally, binary, signal)
      return
    }
    if (f.quiet || f.filesOnly || f.filesWithoutMatch) {
      await listing(lines, pat, f, tally, signal)
      if (binary.skipped) {
        // A walked binary file was never searched, so it is in neither
        // listing.
        tally.skipped = true
        return
      }
      yield* listed(name, f, tally)
      return
    }
    if (f.countOnly || f.countMatches) {
      const total = await count(lines, pat, f, tally, signal)
      if (binary.skipped) return
      yield* counted(total, label, f, tally)
      return
    }
    const printer = new RgPrinter(f, pat, f.heading ? null : label, name)
    yield* printedLines(lines, printer, pat, f, tally, binary, label, signal)
  } catch (error) {
    await discardStreams(source)
    throw error
  } finally {
    tally.nul = binary.offset
    // ripgrep counts the bytes it read up to where it stopped, and a binary
    // file up to its first NUL.
    if (f.multiline !== true) tally.searched = binary.offset ?? lines.position
    await closeQuietly(reader)
    await closeQuietly(source)
  }
}
