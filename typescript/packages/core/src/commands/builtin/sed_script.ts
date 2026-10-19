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

import { RegexError } from '../../rs/errors.ts'
import { PosixRegex } from '../../rs/regex.ts'
import { byteView, decodeText, fromByteView } from '../../shell/bytes.ts'
import { strverscmp } from '../../utils/strverscmp.ts'

export const SED_STDOUT = '/dev/stdout'
export const SED_STDERR = '/dev/stderr'
// The release whose behaviour this follows; `v` refuses a newer one.
export const SED_VERSION = '4.9'

const BLANKS = ' \t'
const SPACES = ' \t\n\v\f\r'
// Under UTF-8 these bytes open a multibyte character, which no delimiter may
// be.
const LEAD_BYTES = ['\xc2', '\xfd'] as const
// What a one-letter escape stands for, in a script's regex, replacement, `y`
// strings and `a`/`i`/`c` text alike.
const CONTROL: Readonly<Record<string, string>> = {
  a: '\x07',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}
const CASE = new Set('LUluE')

/** One -e expression or -f file of a sed command line. Mirrors Python's SedScriptPiece. */
export interface SedScriptPiece {
  readonly kind: 'expr' | 'file'
  readonly text: string
  readonly name?: string | null
}

/**
 * A script sed refuses, worded and coded as GNU sed 4.9 refuses it; `wfiles`
 * are the `w` files opened before it, which GNU has already truncated.
 * Mirrors Python's SedError.
 */
export class SedError extends Error {
  readonly exitCode: number
  readonly wfiles: string[]

  constructor(message: string, exitCode = 1, wfiles: readonly string[] = []) {
    super(message)
    this.name = 'SedError'
    this.exitCode = exitCode
    this.wfiles = [...wfiles]
  }
}

export enum AddressKind {
  LINE = 'line',
  LAST = 'last',
  REGEX = 'regex',
  STEP = 'step',
  PLUS = 'plus',
  MULTIPLE = 'multiple',
}

/** A compiled address or `s` expression; `regex` null for the empty one, which matches as the last used. */
export interface SedRegex {
  readonly regex: PosixRegex | null
}

export interface SedAddress {
  readonly kind: AddressKind
  readonly number: number
  readonly step: number
  readonly regex: SedRegex | null
}

/** A piece of an `s` replacement: `text`, a `group` (0 for the whole match), or a `case` conversion. */
export interface ReplacementPart {
  readonly text: string
  readonly group: number | null
  readonly case: string | null
}

export interface SedSubstitution {
  regex: SedRegex
  parts: ReplacementPart[]
  global: boolean
  occurrence: number
  print: boolean
  wfile: string | null
}

/** One command: its addresses, its letter and what it carries. */
export interface SedCommand {
  name: string
  addr1: SedAddress | null
  addr2: SedAddress | null
  negate: boolean
  text: string | null
  label: string | null
  target: number | null
  filename: string | null
  number: number | null
  subst: SedSubstitution | null
  translit: Map<string, string> | null
  blockEnd: number
}

/**
 * A compiled script: its commands in order, the files its `w`, `r` and `R`
 * commands name in the order they first appear, and whether `#n` made it
 * quiet. Mirrors Python's SedProgram.
 */
export interface SedProgram {
  commands: SedCommand[]
  wfiles: string[]
  rfiles: string[]
  readerFiles: string[]
  quiet: boolean
}

function address(kind: AddressKind, number = 0, step = 0, regex: SedRegex | null = null) {
  return { kind, number, step, regex }
}

function isDigit(ch: string | null): boolean {
  return ch !== null && ch >= '0' && ch <= '9'
}

// The script's pieces as one text of byte views, joined by newlines, read one
// character at a time, with the place GNU names in a diagnostic for the last
// one read. Mirrors Python's _Script.
class Script {
  readonly pieces: SedScriptPiece[]
  readonly starts: number[] = []
  readonly lengths: number[]
  // The newlines that join one piece to the next, which only text continues
  // across.
  readonly joins: Set<number>
  readonly numbers: number[] = []
  readonly text: string
  pos = 0

  constructor(pieces: readonly SedScriptPiece[]) {
    this.pieces = [...pieces]
    const views = this.pieces.map((piece) => byteView(piece.text))
    let at = 0
    for (const view of views) {
      this.starts.push(at)
      at += view.length + 1
    }
    this.lengths = views.map((view) => view.length)
    this.joins = new Set(this.starts.slice(1).map((start) => start - 1))
    this.text = views.join('\n')
    let expressions = 0
    for (const piece of this.pieces) {
      if (piece.kind === 'expr') expressions += 1
      this.numbers.push(expressions)
    }
  }

  peek(): string | null {
    return this.pos < this.text.length ? this.text.charAt(this.pos) : null
  }

  get(): string | null {
    const ch = this.peek()
    if (ch !== null) this.pos += 1
    return ch
  }

  unget(): void {
    this.pos -= 1
  }

  skip(chars: string): string | null {
    for (;;) {
      const ch = this.peek()
      if (ch === null || !chars.includes(ch)) return ch
      this.pos += 1
    }
  }

  private pieceAt(last: number): number {
    let index = 0
    for (let i = 0; i < this.starts.length; i++) if ((this.starts[i] ?? 0) <= last) index = i
    return index
  }

  where(at: number | null = null): string {
    const last = (at ?? this.pos) - 1
    const index = this.pieceAt(Math.max(last, 0))
    const piece = this.pieces[index]
    const start = this.starts[index] ?? 0
    const offset = last - start
    if (piece?.kind === 'file') {
      const body = this.text.slice(start, start + offset)
      return `file ${piece.name ?? ''} line ${String(body.split('\n').length)}`
    }
    const count = Math.min(Math.max(offset + 1, 0), this.lengths[index] ?? 0)
    return `-e expression #${String(this.numbers[index] ?? 1)}, char ${String(count)}`
  }

  lastWhere(): string {
    const index = this.pieces.length - 1
    const piece = this.pieces[index]
    if (piece?.kind === 'file') {
      const text = this.text.slice(this.starts[index] ?? 0)
      return `file ${piece.name ?? ''} line ${String(text.split('\n').length)}`
    }
    return `-e expression #${String(this.numbers[index] ?? 1)}, char 0`
  }
}

const RECURSIVE = 'recursive escaping after \\c not allowed'

// A `\c` before a backslash that does not stand for itself.
class RecursiveEscape extends Error {}

// The character a `\d`, `\o`, `\x` or `\c` escape names, and the index after
// it; null when no digits follow (the escape is then its letter). Throws
// RecursiveEscape for `\c\` followed by anything but a second backslash,
// which GNU refuses.
function numericEscape(text: string, at: number, kind: string): [string, number] | null {
  if (kind === 'c') {
    // `\c` at the end stands for a backslash, and `\c\\` is the control
    // character of a backslash.
    if (at + 1 >= text.length) return ['\\', at + 1]
    const next = text.charAt(at + 1)
    if (next === '\\') {
      if (text.charAt(at + 2) === '\\') return [String.fromCharCode(0x1c), at + 3]
      throw new RecursiveEscape()
    }
    // Only an ASCII letter takes its capital: the text is bytes.
    const code = next.charCodeAt(0)
    return [String.fromCharCode((code >= 0x61 && code <= 0x7a ? code - 0x20 : code) ^ 0x40), at + 2]
  }
  const [base, width, digits] =
    kind === 'd'
      ? [10, 3, '0123456789']
      : kind === 'o'
        ? [8, 3, '01234567']
        : [16, 2, '0123456789abcdefABCDEF']
  let end = at + 1
  while (end < text.length && end - at - 1 < width && digits.includes(text.charAt(end))) end += 1
  if (end === at + 1) return null
  return [String.fromCharCode(parseInt(text.slice(at + 1, end), base) & 0xff), end]
}

// A sed escape at `text[at]`, the letter after a backslash; null when the
// letter is no sed escape.
function escape(text: string, at: number): [string, number] | null {
  const ch = text.charAt(at)
  const control = CONTROL[ch]
  if (control !== undefined) return [control, at + 1]
  if ('doxc'.includes(ch) && ch !== '') return numericEscape(text, at, ch)
  return null
}

// An expression's text as regcomp gets it from sed: the escapes sed reads
// itself turned into the characters they stand for, which keep whatever
// meaning they have there (`\x2e` is any character).
function regexText(raw: string): string {
  const out: string[] = []
  let i = 0
  while (i < raw.length) {
    const ch = raw.charAt(i)
    if (ch !== '\\' || i + 1 >= raw.length) {
      out.push(ch)
      i += 1
      continue
    }
    const found = escape(raw, i + 1)
    if (found === null) {
      out.push(raw.slice(i, i + 2))
      i += 2
      continue
    }
    out.push(found[0])
    i = found[1]
  }
  return out.join('')
}

// A `y` string's characters: `\\` a backslash, sed's escapes the characters
// they name, and any other escaped character itself. `raw` is the string
// between its delimiters, an escaped delimiter already the plain one.
function yText(raw: string): string {
  const out: string[] = []
  let i = 0
  while (i < raw.length) {
    const ch = raw.charAt(i)
    if (ch !== '\\' || i + 1 >= raw.length) {
      out.push(ch)
      i += 1
      continue
    }
    const next = raw.charAt(i + 1)
    const found = next === '\\' ? null : escape(raw, i + 1)
    if (found === null) {
      out.push(next)
      i += 2
      continue
    }
    out.push(found[0])
    i = found[1]
  }
  return out.join('')
}

type Handler = (compiler: Compiler, cmd: SedCommand) => void

// Reads a script into a SedProgram the way GNU sed 4.9 does. Mirrors Python's
// _Compiler.
class Compiler {
  readonly src: Script
  readonly program: SedProgram = {
    commands: [],
    wfiles: [],
    rfiles: [],
    readerFiles: [],
    quiet: false,
  }
  readonly blocks: number[] = []

  constructor(
    pieces: readonly SedScriptPiece[],
    readonly extended: boolean,
    readonly utf8: boolean,
  ) {
    this.src = new Script(pieces)
  }

  fail(message: string): SedError {
    return new SedError(`sed: ${this.src.where()}: ${message}`, 1, this.program.wfiles)
  }

  failAt(at: number | null, message: string): SedError {
    return new SedError(`sed: ${this.src.where(at)}: ${message}`, 1, this.program.wfiles)
  }

  view(raw: string): string {
    return this.utf8 ? decodeText(fromByteView(raw)) : raw
  }

  compile(): SedProgram {
    const src = this.src
    if (src.text.startsWith('#n')) this.program.quiet = true
    for (;;) {
      const ch = src.skip(SPACES + ';')
      if (ch === null) break
      if (ch === '#') {
        this.comment()
        continue
      }
      this.command()
    }
    if (this.blocks.length > 0)
      throw new SedError(`sed: ${src.lastWhere()}: unmatched \`{'`, 1, this.program.wfiles)
    this.resolve()
    return this.program
  }

  comment(): void {
    for (;;) {
      const ch = this.src.get()
      if (ch === null || ch === '\n') return
    }
  }

  resolve(): void {
    const labels = new Map<string, number>()
    this.program.commands.forEach((cmd, index) => {
      if (cmd.name === ':' && cmd.label !== null && !labels.has(cmd.label))
        labels.set(cmd.label, index)
    })
    for (const cmd of this.program.commands) {
      if (!'btT'.includes(cmd.name)) continue
      if (cmd.label === null || cmd.label === '') {
        cmd.target = this.program.commands.length
        continue
      }
      const target = labels.get(cmd.label)
      if (target === undefined)
        throw new SedError(
          `sed: can't find label for jump to \`${decodeText(fromByteView(cmd.label))}'`,
          4,
          this.program.wfiles,
        )
      cmd.target = target
    }
  }

  // The digits here, kept to 64 bits as sed counts them, so no length of
  // them is refused. A bigint, since a number past 2^53 must still wrap
  // exactly; callers take the reading they need.
  number(): bigint {
    const src = this.src
    let value = 0n
    for (let ch = src.peek(); ch !== null && isDigit(ch); ch = src.peek()) {
      value = BigInt.asUintN(64, value * 10n + BigInt(ch.charCodeAt(0) - 48))
      src.pos += 1
    }
    return value
  }

  // Refuse a delimiter that opens a multibyte character.
  delimiter(delim: string): void {
    const [low, high] = LEAD_BYTES
    if (this.utf8 && delim >= low && delim <= high)
      throw this.fail('delimiter character is not a single-byte character')
  }

  address(): SedAddress | null {
    const src = this.src
    const ch = src.peek()
    if (ch === null) return null
    if (isDigit(ch)) {
      const first = Number(this.number())
      if (src.skip(BLANKS) === '~') {
        src.get()
        src.skip(BLANKS)
        const step = isDigit(src.peek()) ? Number(this.number()) : 0
        // `first~0` is the line `first` itself.
        if (step === 0) return address(AddressKind.LINE, first)
        return address(AddressKind.STEP, first, step)
      }
      return address(AddressKind.LINE, first)
    }
    if (ch === '$') {
      src.get()
      return address(AddressKind.LAST)
    }
    if (ch === '/' || ch === '\\') {
      src.get()
      let delim = '/'
      if (ch === '\\') {
        const got = src.get()
        if (got === null || got === '\n') throw this.fail('unterminated address regex')
        this.delimiter(got)
        delim = got
      }
      const raw = this.delimited(delim, 'unterminated address regex')
      let icase = false
      let multiline = false
      for (;;) {
        const flag = src.skip(BLANKS)
        if (flag !== 'I' && flag !== 'M') break
        src.get()
        if (flag === 'I') icase = true
        else multiline = true
      }
      return address(AddressKind.REGEX, 0, 0, this.regex(raw, icase, multiline))
    }
    return null
  }

  secondAddress(): SedAddress {
    const src = this.src
    const ch = src.skip(BLANKS)
    if (ch === '+' || ch === '~') {
      src.get()
      src.skip(BLANKS)
      if (!isDigit(src.peek())) {
        src.get()
        throw this.fail("unexpected `,'")
      }
      const count = this.number()
      // `+N` keeps the signed reading, exact near 2^64 where its end wraps
      // back to a small line.
      if (ch === '+') return address(AddressKind.PLUS, Number(BigInt.asIntN(64, count)))
      return address(AddressKind.MULTIPLE, Number(count))
    }
    const found = this.address()
    if (found === null) {
      src.get()
      throw this.fail("unexpected `,'")
    }
    return found
  }

  // The text up to an unescaped `delim`, bracket expressions read whole, a
  // `\delim` made the plain delimiter and a backslash-newline a newline.
  delimited(delim: string, unterminated: string): string {
    const src = this.src
    const out: string[] = []
    for (;;) {
      const ch = src.get()
      if (ch === null || ch === '\n') throw this.fail(unterminated)
      if (ch === delim) return out.join('')
      if (ch === '\\') {
        const next = src.get()
        if (next === null || (next === '\n' && src.joins.has(src.pos - 1)))
          throw this.fail(unterminated)
        if (next === delim) out.push(delim)
        else if (next === '\n') out.push('\n')
        else out.push('\\' + next)
        continue
      }
      if (ch === '[') {
        out.push(this.bracket(unterminated))
        continue
      }
      out.push(ch)
    }
  }

  // A bracket expression, from after its `[`: the delimiter is an ordinary
  // character inside it.
  bracket(unterminated: string): string {
    const src = this.src
    const out = ['[']
    if (src.peek() === '^') out.push(src.get() ?? '')
    if (src.peek() === ']') out.push(src.get() ?? '')
    for (;;) {
      const ch = src.get()
      if (ch === null || ch === '\n') throw this.fail(unterminated)
      if (ch === ']') {
        out.push(ch)
        return out.join('')
      }
      const next = src.peek()
      if (ch === '[' && (next === ':' || next === '.' || next === '=')) {
        const kind = src.get() ?? ''
        out.push('[' + kind)
        for (;;) {
          const inner = src.get()
          if (inner === null || inner === '\n') throw this.fail(unterminated)
          out.push(inner)
          if (inner === kind && src.peek() === ']') {
            out.push(src.get() ?? '')
            break
          }
        }
        continue
      }
      out.push(ch)
    }
  }

  regex(raw: string, icase: boolean, multiline: boolean): SedRegex {
    if (raw === '') {
      if (icase || multiline) throw this.fail('cannot specify modifiers on empty regexp')
      return { regex: null }
    }
    let text: string
    try {
      text = this.view(regexText(raw))
    } catch (err) {
      if (err instanceof RecursiveEscape) throw this.fail(RECURSIVE)
      throw err
    }
    try {
      return { regex: new PosixRegex(text, this.extended, 'sed', icase, this.utf8, multiline) }
    } catch (err) {
      if (!(err instanceof RegexError)) throw err
      if (err.message.startsWith('character class syntax is'))
        throw new SedError(`sed: ${err.message}`, 4, this.program.wfiles)
      throw this.fail(err.message)
    }
  }

  endOfCommand(): void {
    const src = this.src
    const ch = src.skip(BLANKS)
    if (ch === null) return
    if (ch === '\n' || ch === ';') {
      src.get()
      return
    }
    if (ch === '}' || ch === '#') return
    src.get()
    throw this.fail('extra characters after command')
  }

  command(): void {
    const src = this.src
    const cmd: SedCommand = {
      name: '',
      addr1: null,
      addr2: null,
      negate: false,
      text: null,
      label: null,
      target: null,
      filename: null,
      number: null,
      subst: null,
      translit: null,
      blockEnd: 0,
    }
    cmd.addr1 = this.address()
    if (cmd.addr1 !== null && src.skip(BLANKS) === ',') {
      src.get()
      cmd.addr2 = this.secondAddress()
    }
    let ch = src.skip(BLANKS)
    let bang: number | null = null
    if (ch === '!') {
      src.get()
      bang = src.pos
      cmd.negate = true
      ch = src.skip(BLANKS)
      if (ch === '!') {
        src.get()
        throw this.fail("multiple `!'s")
      }
    }
    const name = src.get()
    if (name === null || name === '\n' || name === ';') throw this.fail('missing command')
    cmd.name = name
    this.checkAddresses(cmd, bang)
    const handler = HANDLERS[name]
    if (handler === undefined) {
      if (name === 'e') throw this.fail("`e' command not supported")
      throw this.fail(`unknown command: \`${name}'`)
    }
    handler(this, cmd)
  }

  // Refuse addresses the command cannot take, where GNU does: line 0 at the `!`
  // when there is one, the rest at the command.
  checkAddresses(cmd: SedCommand, bang: number | null): void {
    const first = cmd.addr1
    const second = cmd.addr2
    if (first !== null && first.number === 0) {
      const zeroLine =
        first.kind === AddressKind.LINE &&
        second?.kind !== AddressKind.REGEX &&
        !(cmd.name === 'r' && second === null)
      if (zeroLine) throw this.failAt(bang, 'invalid usage of line address 0')
    }
    if (cmd.name === ':' && first !== null) throw this.fail(": doesn't want any addresses")
    if (cmd.name === '#' && first !== null) throw this.fail("comments don't accept any addresses")
    if ((cmd.name === 'q' || cmd.name === 'Q') && second !== null)
      throw this.fail('command only uses one address')
  }

  add(cmd: SedCommand): void {
    this.program.commands.push(cmd)
  }

  label(): string {
    const src = this.src
    src.skip(BLANKS)
    const start = src.pos
    for (;;) {
      const ch = src.peek()
      if (ch === null || (SPACES + ';}#').includes(ch)) break
      src.pos += 1
    }
    return src.text.slice(start, src.pos)
  }

  filename(): string {
    const src = this.src
    src.skip(BLANKS)
    const start = src.pos
    for (;;) {
      const ch = src.peek()
      if (ch === null || ch === '\n') break
      src.pos += 1
    }
    const name = src.text.slice(start, src.pos)
    if (name === '') throw this.fail('missing filename in r/R/w/W commands')
    if (src.peek() === '\n') src.get()
    // A name is shell text in either locale, which the files resolve.
    return decodeText(fromByteView(name))
  }

  wfile(name: string): void {
    if (!this.program.wfiles.includes(name)) this.program.wfiles.push(name)
  }

  // The text of `a`, `i` or `c`: GNU's one-line form after blanks, or after a
  // backslash and a newline the lines that follow, each escaped newline
  // continuing it. Null when there is none at all. `name` is the command.
  text(name: string): string | null {
    const src = this.src
    let ch = src.skip(BLANKS)
    if (ch === null || ch === '\n') throw this.fail("expected \\ after `a', `c' or `i'")
    if (ch === '\\') {
      src.get()
      if (src.peek() === '\n') src.get()
      else if (src.peek() === null) return null
    }
    const out: string[] = []
    let read = false
    let recursive = false
    const start = src.pos
    while ((ch = src.get()) !== null) {
      read = true
      if (ch === '\n') break
      if (ch !== '\\') {
        out.push(ch)
        continue
      }
      const next = src.peek()
      // Text that runs to the end of the script on a backslash goes out as
      // written, that backslash dropped.
      if (next === null) return this.view(src.text.slice(start, src.pos - 1)) + '\n'
      src.get()
      if (next === '\n') {
        out.push('\n')
        continue
      }
      const after = src.peek()
      if (next === 'c' && (after === null || after === '\n')) {
        // A `\c` that ends the text: `a` takes the closing newline into it
        // (^J), `i` and `c` drop it.
        if (after === '\n') src.get()
        if (recursive) throw this.fail(RECURSIVE)
        return name === 'a' ? this.view(out.join('') + 'J') : this.view(out.join('')) + '\n'
      }
      let found: [string, number] | null
      try {
        found = escape(src.text, src.pos - 1)
      } catch (err) {
        if (!(err instanceof RecursiveEscape)) throw err
        // GNU refuses it once the text has been read.
        recursive = true
        continue
      }
      if (found === null) {
        out.push(next)
        continue
      }
      out.push(found[0])
      src.pos = found[1]
    }
    if (recursive) throw this.fail(RECURSIVE)
    if (!read) return null
    return this.view(out.join('')) + '\n'
  }

  replacement(raw: string, groups: number): ReplacementPart[] {
    const parts: ReplacementPart[] = []
    let literal: string[] = []
    const flush = (): void => {
      if (literal.length > 0) {
        parts.push({ text: this.view(literal.join('')), group: null, case: null })
        literal = []
      }
    }
    let i = 0
    while (i < raw.length) {
      const ch = raw.charAt(i)
      if (ch === '&') {
        flush()
        parts.push({ text: '', group: 0, case: null })
        i += 1
        continue
      }
      if (ch !== '\\' || i + 1 >= raw.length) {
        literal.push(ch)
        i += 1
        continue
      }
      const next = raw.charAt(i + 1)
      if (isDigit(next)) {
        const group = Number(next)
        if (group > groups)
          throw this.fail(`invalid reference \\${String(group)} on \`s' command's RHS`)
        flush()
        parts.push({ text: '', group, case: null })
        i += 2
        continue
      }
      if (CASE.has(next)) {
        flush()
        parts.push({ text: '', group: null, case: next })
        i += 2
        continue
      }
      const found = escape(raw, i + 1)
      if (found === null) {
        literal.push(next)
        i += 2
        continue
      }
      literal.push(found[0])
      i = found[1]
    }
    flush()
    return parts
  }

  substitute(cmd: SedCommand): void {
    const src = this.src
    const delim = src.get()
    if (delim === null || delim === '\n' || delim === '\\')
      throw this.fail("unterminated `s' command")
    this.delimiter(delim)
    const raw = this.delimited(delim, "unterminated `s' command")
    const rhs = this.rhs(delim)
    const subst: SedSubstitution = {
      regex: { regex: null },
      parts: [],
      global: false,
      occurrence: 1,
      print: false,
      wfile: null,
    }
    let icase = false
    let multiline = false
    let seenG = false
    let seenP = false
    let seenN = false
    for (;;) {
      const ch = src.get()
      if (ch === null || ch === '\n' || ch === ';') break
      if (ch === '}' || ch === '#') {
        src.unget()
        break
      }
      if (ch === '\r' && src.peek() === '\n') {
        // A script written with CRLF line ends.
        src.get()
        break
      }
      if (BLANKS.includes(ch)) continue
      if (ch === 'g') {
        if (seenG) throw this.fail("multiple `g' options to `s' command")
        seenG = subst.global = true
      } else if (ch === 'p') {
        if (seenP) throw this.fail("multiple `p' options to `s' command")
        seenP = subst.print = true
      } else if (isDigit(ch)) {
        src.unget()
        if (seenN) {
          this.number()
          throw this.fail("multiple number options to `s' command")
        }
        seenN = true
        subst.occurrence = Number(this.number())
        if (subst.occurrence === 0) throw this.fail("number option to `s' command may not be zero")
      } else if (ch === 'i' || ch === 'I') icase = true
      else if (ch === 'm' || ch === 'M') multiline = true
      else if (ch === 'e') throw this.fail("`e' command not supported")
      else if (ch === 'w') {
        subst.wfile = this.filename()
        this.wfile(subst.wfile)
        break
      } else throw this.fail("unknown option to `s'")
    }
    subst.regex = this.regex(raw, icase, multiline)
    const groups = subst.regex.regex === null ? 9 : subst.regex.regex.groups
    try {
      subst.parts = this.replacement(rhs, groups)
    } catch (err) {
      if (err instanceof RecursiveEscape) throw this.fail(RECURSIVE)
      throw err
    }
    cmd.subst = subst
    this.add(cmd)
  }

  // An `s` replacement up to its unescaped delimiter, escapes kept for
  // `replacement` and a `\delim` its literal character.
  rhs(delim: string): string {
    const src = this.src
    const out: string[] = []
    for (;;) {
      const ch = src.get()
      if (ch === null || ch === '\n') throw this.fail("unterminated `s' command")
      if (ch === delim) return out.join('')
      if (ch === '\\') {
        const next = src.get()
        if (next === null || (next === '\n' && src.joins.has(src.pos - 1)))
          throw this.fail("unterminated `s' command")
        if (next === delim) out.push(delim === '&' || delim === '\\' ? '\\' + delim : delim)
        else if (next === '\n') out.push('\n')
        else out.push('\\' + next)
        continue
      }
      out.push(ch)
    }
  }

  transliterate(cmd: SedCommand): void {
    const src = this.src
    const delim = src.get()
    if (delim === null || delim === '\n' || delim === '\\')
      throw this.fail("unterminated `y' command")
    this.delimiter(delim)
    const left = Array.from(this.view(this.yString(delim)))
    const right = Array.from(this.view(this.yString(delim)))
    if (left.length !== right.length)
      throw this.fail("strings for `y' command are different lengths")
    const table = new Map<string, string>()
    left.forEach((a, index) => {
      if (!table.has(a)) table.set(a, right[index] ?? a)
    })
    cmd.translit = table
    this.endOfCommand()
    this.add(cmd)
  }

  // One `y` string: read up to its delimiter first, so no escape can take
  // the delimiter, then decoded.
  yString(delim: string): string {
    const src = this.src
    const raw: string[] = []
    for (;;) {
      const ch = src.get()
      if (ch === null || ch === '\n') throw this.fail("unterminated `y' command")
      if (ch === delim) break
      if (ch !== '\\') {
        raw.push(ch)
        continue
      }
      const next = src.get()
      if (next === null || (next === '\n' && src.joins.has(src.pos - 1)))
        throw this.fail("unterminated `y' command")
      raw.push(next === delim ? next : '\\' + next)
    }
    try {
      return yText(raw.join(''))
    } catch (err) {
      // GNU refuses it at the end of the string.
      if (err instanceof RecursiveEscape) throw this.fail(RECURSIVE)
      throw err
    }
  }
}

function simple(compiler: Compiler, cmd: SedCommand): void {
  compiler.endOfCommand()
  compiler.add(cmd)
}

function openBlock(compiler: Compiler, cmd: SedCommand): void {
  compiler.blocks.push(compiler.program.commands.length)
  compiler.add(cmd)
}

function closeBlock(compiler: Compiler, cmd: SedCommand): void {
  if (compiler.blocks.length === 0) throw compiler.fail("unexpected `}'")
  if (cmd.addr1 !== null) throw compiler.fail("`}' doesn't want any addresses")
  const start = compiler.blocks.pop() ?? 0
  const opened = compiler.program.commands[start]
  if (opened !== undefined) opened.blockEnd = compiler.program.commands.length
  compiler.endOfCommand()
  compiler.add(cmd)
}

function withNumber(compiler: Compiler, cmd: SedCommand): void {
  compiler.src.skip(BLANKS)
  // `l` and `q` keep their number's low 32 bits as a signed int.
  if (isDigit(compiler.src.peek())) cmd.number = Number(BigInt.asIntN(32, compiler.number()))
  compiler.endOfCommand()
  compiler.add(cmd)
}

function text(compiler: Compiler, cmd: SedCommand): void {
  cmd.text = compiler.text(cmd.name)
  compiler.add(cmd)
}

function label(compiler: Compiler, cmd: SedCommand): void {
  const label = compiler.label()
  if (label === '') throw compiler.fail('":" lacks a label')
  cmd.label = label
  compiler.add(cmd)
}

function branch(compiler: Compiler, cmd: SedCommand): void {
  cmd.label = compiler.label()
  compiler.add(cmd)
}

function readFile(compiler: Compiler, cmd: SedCommand): void {
  const name = compiler.filename()
  cmd.filename = name
  const names = cmd.name === 'r' ? compiler.program.rfiles : compiler.program.readerFiles
  if (!names.includes(name)) names.push(name)
  compiler.add(cmd)
}

function writeFile(compiler: Compiler, cmd: SedCommand): void {
  cmd.filename = compiler.filename()
  compiler.wfile(cmd.filename)
  compiler.add(cmd)
}

function substitute(compiler: Compiler, cmd: SedCommand): void {
  compiler.substitute(cmd)
}

function transliterate(compiler: Compiler, cmd: SedCommand): void {
  compiler.transliterate(cmd)
}

function version(compiler: Compiler): void {
  const src = compiler.src
  src.skip(BLANKS)
  const start = src.pos
  for (;;) {
    const ch = src.peek()
    if (ch === null || (SPACES + ';}#').includes(ch)) break
    src.pos += 1
  }
  const wanted = src.text.slice(start, src.pos)
  if (wanted !== '' && strverscmp(wanted, SED_VERSION) > 0)
    throw compiler.fail('expected newer version of sed')
  compiler.endOfCommand()
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  '{': openBlock,
  '}': closeBlock,
  '=': simple,
  a: text,
  i: text,
  c: text,
  b: branch,
  t: branch,
  T: branch,
  ':': label,
  d: simple,
  D: simple,
  F: simple,
  g: simple,
  G: simple,
  h: simple,
  H: simple,
  l: withNumber,
  // sed 4.9 still reads `L` as `l` reads, and refuses it where it runs.
  L: withNumber,
  n: simple,
  N: simple,
  p: simple,
  P: simple,
  q: withNumber,
  Q: withNumber,
  r: readFile,
  R: readFile,
  s: substitute,
  v: (compiler) => {
    version(compiler)
  },
  w: writeFile,
  W: writeFile,
  x: simple,
  y: transliterate,
  z: simple,
}

/**
 * Compile a sed script as GNU sed 4.9 reads it. The pieces join with
 * newlines, so one command may span them (`-e 'a\' -e 'text'`), and each
 * diagnostic names the piece it is in: `-e expression #N, char C` or `file
 * NAME line L`. Throws SedError for a script GNU refuses, in its wording.
 * Mirrors Python's compile_script.
 */
export function compileScript(
  pieces: readonly SedScriptPiece[],
  extended: boolean,
  utf8 = false,
): SedProgram {
  return new Compiler(pieces, extended, utf8).compile()
}
