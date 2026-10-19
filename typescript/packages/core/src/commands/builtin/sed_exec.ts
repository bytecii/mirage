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

import { fsStrerror, isFsError } from '../../errors/fs.ts'
import { chunks } from '../../io/cooperative.ts'
import { closeQuietly, ensureStream } from '../../io/stream.ts'
import { abortable } from '../../utils/abort.ts'
import type { ByteSource } from '../../io/types.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import type { Groups, PosixRegex } from '../../rs/regex.ts'
import { byteView, fromByteView, textView } from '../../shell/bytes.ts'
import {
  AddressKind,
  SED_STDERR,
  SED_STDOUT,
  type ReplacementPart,
  type SedAddress,
  type SedCommand,
  type SedProgram,
  type SedRegex,
  type SedSubstitution,
} from './sed_script.ts'

export const SED_LINE_LENGTH = 70
// How many pieces of output a run holds before it hands them on.
const CHUNK = 1 << 12
const ESCAPES: Readonly<Record<number, string>> = {
  0x5c: '\\\\',
  0x07: '\\a',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
  0x0b: '\\v',
}

/**
 * An `r` or `R` file: read whole as a byte view, read when the script gets to
 * it, or one that opens and cannot be read (GNU reports `error` and exits 4
 * when it gets there). Mirrors Python's SedFileContent.
 */
export type SedFileContent = SedFileText | SedFileSource | SedFileError | null

/** An `r` or `R` file read whole, as a byte view. */
export interface SedFileText {
  readonly text: string
}

/** An `r` or `R` file read when the script gets to it. */
export interface SedFileSource {
  readonly read: () => AsyncIterable<Uint8Array>
}

/** An `r` or `R` file that opens and cannot be read: GNU reports `error` and exits 4 when it gets there. */
export interface SedFileError {
  readonly error: string
}

/** One input: its name as `F` prints it (`-` for stdin) and its bytes. Mirrors Python's SedInput. */
export interface SedInput {
  readonly name: string
  readonly source: ByteSource
}

/** How a script runs. Mirrors Python's SedRunOptions. */
export interface SedRunOptions {
  readonly suppress: boolean
  readonly separate: boolean
  readonly lineLength: number
  files: ReadonlyMap<string, SedFileContent>
  readonly readerFiles: ReadonlyMap<string, SedFileContent>
  readonly utf8: boolean
}

/**
 * One output sed writes, as byte views, and whether its last line went out
 * without the newline the input lacked: anything written after it puts that
 * newline first. Mirrors Python's SedOutput.
 */
export class SedOutput {
  missingNewline = false

  constructor(readonly chunks: string[] = []) {}

  write(text: string): void {
    if (text === '') return
    if (this.missingNewline) {
      this.chunks.push('\n')
      this.missingNewline = false
    }
    this.chunks.push(text)
  }

  line(text: string, newline: boolean): void {
    if (this.missingNewline) {
      this.chunks.push('\n')
      this.missingNewline = false
    }
    this.chunks.push(text)
    if (newline) this.chunks.push('\n')
    else this.missingNewline = true
  }
}

// sed stops: `message` goes to stderr and it exits `code`.
class Panic extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

interface Line {
  readonly text: string
  readonly newline: boolean
  readonly source: number
}

// The failures of opening an input, which GNU reports and reads on past (exit
// 2); any other is a read error that stops it (exit 4).
const OPEN_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'])

function opensFailed(err: unknown): boolean {
  return OPEN_ERRORS.has((err as { code?: string } | null)?.code ?? '')
}

function readError(name: string, err: unknown): Panic {
  return new Panic(`sed: read error on ${name}: ${fsStrerror(err) ?? String(err)}\n`, 4)
}

// Whether the command is addressed by line 0 alone (`0r`).
// The status `q` and `Q` exit with: the low byte of their number, except that
// -1 (low 32 bits all ones) exits 0, as sed 4.9 does. Mirrors Python's
// _quit_code.
function quitCode(number: number | null): number {
  if (number === null || number === -1) return 0
  return number & 0xff
}

function zeroLine(cmd: SedCommand): boolean {
  const first = cmd.addr1
  return (
    first !== null && cmd.addr2 === null && first.kind === AddressKind.LINE && first.number === 0
  )
}

// `text` cut after each newline, and only there.
function cutLines(text: string): string[] {
  const lines = text.split('\n')
  const last = lines.pop() ?? ''
  const out = lines.map((line) => line + '\n')
  if (last !== '') out.push(last)
  return out
}

// The lines of one byte source, read through one growing buffer: a line's
// pieces are searched once each and copied once, however many chunks it
// arrives in. Mirrors Python's _Reader.
class Reader {
  readonly chunks: AsyncIterator<Uint8Array>
  private buffer: Uint8Array = new Uint8Array()
  // The bytes held, where the unread ones start, and how far a newline was
  // looked for among them.
  private end = 0
  private start = 0
  private scanned = 0
  private ended = false
  started = false

  // `machine` paces each pull with its budget and its abort, so a line that
  // never ends still lets the loop run and a stalled pull loses to the abort.
  constructor(
    source: ByteSource,
    private readonly utf8: boolean,
    private readonly machine: SedMachine,
  ) {
    this.chunks = ensureStream(source)[Symbol.asyncIterator]()
  }

  private async pull(): Promise<void> {
    await this.machine.budget.run()
    const next = await abortable(this.chunks.next(), this.machine.signal)
    if (next.done === true) {
      this.ended = true
      return
    }
    this.started = true
    const chunk = next.value
    const live = this.end - this.start
    if (this.end + chunk.length > this.buffer.length) {
      // Move the unread bytes to the front, into a buffer twice as large
      // when they fill more than half of this one.
      const need = live + chunk.length
      const target =
        need <= this.buffer.length && live <= this.buffer.length / 2
          ? this.buffer
          : new Uint8Array(Math.max(need, this.buffer.length * 2))
      target.set(this.buffer.subarray(this.start, this.end))
      this.scanned -= this.start
      this.start = 0
      this.end = live
      this.buffer = target
    }
    this.buffer.set(chunk, this.end)
    this.end += chunk.length
  }

  // Whether another byte follows, pulling no more than it takes to see one.
  async peek(): Promise<boolean> {
    while (this.start >= this.end) {
      if (this.ended) return false
      await this.pull()
    }
    return true
  }

  private newline(): number {
    const cut = this.buffer.subarray(0, this.end).indexOf(0x0a, Math.max(this.scanned, this.start))
    if (cut < 0) this.scanned = this.end
    return cut
  }

  // Whether the next line is in hand without a pull.
  hasLine(): boolean {
    return this.ended || this.newline() >= 0
  }

  async line(): Promise<[string, boolean] | null> {
    for (;;) {
      const cut = this.newline()
      if (cut >= 0) {
        const text = byteView(this.buffer.subarray(this.start, cut), this.utf8)
        this.start = this.scanned = cut + 1
        return [text, true]
      }
      if (this.ended) {
        if (this.start >= this.end) return null
        const text = byteView(this.buffer.subarray(this.start, this.end), this.utf8)
        this.start = this.scanned = this.end
        return [text, false]
      }
      await this.pull()
    }
  }
}

// The input lines, one input after another, with the one-byte look-ahead sed
// needs for `$`, `n` and `N`: an input that fails as it is looked into ends
// there without a word, where reading on reports it. Mirrors Python's _Feed.
class Feed {
  index = -1
  private reader: Reader | null = null

  constructor(
    private readonly machine: SedMachine,
    private readonly inputs: readonly SedInput[],
  ) {}

  name(index: number): string {
    return this.inputs[index]?.name ?? '-'
  }

  // Whether the next line takes a pull, which may wait on the input.
  waits(): boolean {
    if (this.reader === null) return this.index + 1 < this.inputs.length
    return !this.reader.hasLine()
  }

  private async nextOfReader(): Promise<Line | null> {
    const reader = this.reader
    if (reader === null) return null
    const name = this.name(this.index)
    let got: [string, boolean] | null
    try {
      got = await reader.line()
    } catch (err) {
      if (!isFsError(err)) throw err
      this.reader = null
      if (opensFailed(err) && !reader.started) {
        this.machine.badInput(name, err)
        return null
      }
      const shown = name === '-' ? 'stdin' : name
      throw new Panic(`sed: read error on ${shown}: ${fsStrerror(err) ?? String(err)}\n`, 4)
    }
    if (got === null) {
      this.reader = null
      return null
    }
    return { text: got[0], newline: got[1], source: this.index }
  }

  private advance(): boolean {
    if (this.index + 1 >= this.inputs.length) return false
    this.index += 1
    const input = this.inputs[this.index]
    this.reader =
      input === undefined ? null : new Reader(input.source, this.machine.opts.utf8, this.machine)
    return true
  }

  async read(): Promise<Line | null> {
    for (;;) {
      if (this.reader !== null) {
        const got = await this.nextOfReader()
        if (got !== null) return got
      }
      if (!this.advance()) return null
    }
  }

  private async peek(reader: Reader): Promise<boolean> {
    try {
      if (await reader.peek()) return true
    } catch (err) {
      if (!isFsError(err)) throw err
      if (opensFailed(err) && !reader.started) this.machine.badInput(this.name(this.index), err)
      else console.debug('sed look-ahead ends at a failed read:', err)
    }
    this.reader = null
    return false
  }

  // Whether another line follows, in the current input only when `within`.
  async more(within: boolean): Promise<boolean> {
    for (;;) {
      if (this.reader !== null && (await this.peek(this.reader))) return true
      if (within || !this.advance()) return false
    }
  }
}

function asciiCase(text: string, upper: boolean): string {
  let out = ''
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (upper && code >= 0x61 && code <= 0x7a) out += String.fromCharCode(code - 0x20)
    else if (!upper && code >= 0x41 && code <= 0x5a) out += String.fromCharCode(code + 0x20)
    else out += ch
  }
  return out
}

function unicodeCase(text: string, upper: boolean): string {
  let out = ''
  for (const ch of text) {
    const other = upper ? ch.toUpperCase() : ch.toLowerCase()
    out += Array.from(other).length === 1 ? other : ch
  }
  return out
}

type Entry = readonly ['text' | 'file', string]

/**
 * Runs a compiled script over its inputs as GNU sed 4.9 does. The pattern and
 * hold spaces, the append queue, the ranges and the `w` outputs live here;
 * `process` reads the inputs and yields what the script prints, as byte views.
 * Mirrors Python's SedMachine.
 */
export class SedMachine {
  readonly quiet: boolean
  readonly wfiles = new Map<string, SedOutput>()
  readonly stdout = new SedOutput()
  panicCode: number | null = null
  hold = ''
  line = 0
  // Whether the hold space's text ended in a newline when read: it travels
  // with the text into the pattern space.
  private holdNewline = true
  // Line-number ranges that have started, which never start again.
  private begun = new Set<number>()
  private readonly stderrParts: string[] = []
  private readonly errorOut = new SedOutput()
  private bad = false
  private quitCode: number | null = null
  private last: PosixRegex | null = null
  private ranges = new Map<number, number>()
  private readers = new Map<string, string[] | Reader | null>()
  // Readers a new input under -s left behind, closed with the rest.
  private stale: Reader[] = []
  private out = new SedOutput()
  // `w /dev/stdout` is its own stream into the same output, so a line it
  // writes without a newline does not hold back the next print.
  private stdoutAlias = new SedOutput(this.out.chunks)
  // The rest of each `r` file in `out`: the piece it follows, its name and its
  // stream.
  private tails: [number, string, AsyncIterator<Uint8Array>][] = []
  // The budget between chances for timers and an abort, which the readers
  // take too, and the abort a stalled pull loses to.
  budget = new YieldBudget()
  signal: AbortSignal | undefined
  // Where the line `cycle` hands back resumes: 0 for `D`, a branch's target
  // for a cycle that stopped to hand its output on.
  private resume = 0
  // Whether that line resumes the `n` it stopped in after its print.
  private reading = false
  // The commands that may look ahead or read: before one of them, output
  // waiting on the input goes out first.
  private readonly reads: readonly boolean[]
  private queue: Entry[] = []
  private replaced = false
  private source = -1
  private started = false
  private inline = true
  private feed: Feed
  private readonly changeCase: (text: string, upper: boolean) => string

  constructor(
    readonly program: SedProgram,
    readonly opts: SedRunOptions,
  ) {
    this.quiet = opts.suppress || program.quiet
    for (const name of program.wfiles)
      if (name !== SED_STDOUT && name !== SED_STDERR) this.wfiles.set(name, new SedOutput())
    this.feed = new Feed(this, [])
    this.changeCase = opts.utf8 ? unicodeCase : asciiCase
    this.reads = program.commands.map(
      (cmd) =>
        cmd.name === 'n' ||
        cmd.name === 'N' ||
        cmd.addr1?.kind === AddressKind.LAST ||
        cmd.addr2?.kind === AddressKind.LAST,
    )
  }

  stopped(): boolean {
    return this.quitCode !== null || this.panicCode !== null
  }

  setFiles(files: ReadonlyMap<string, SedFileContent>): void {
    this.opts.files = files
  }

  stderr(): string {
    return this.stderrParts.join('')
  }

  exitCode(): number {
    if (this.panicCode !== null) return this.panicCode
    if (this.bad) return 2
    return this.quitCode ?? 0
  }

  badInput(name: string, err: unknown): void {
    this.bad = true
    this.stderrParts.push(`sed: can't read ${name}: ${fsStrerror(err) ?? String(err)}\n`)
  }

  private output(name: string): SedOutput {
    if (name === SED_STDOUT) return this.inline ? this.stdoutAlias : this.stdout
    if (name === SED_STDERR) return this.errorOut
    const out = this.wfiles.get(name)
    if (out === undefined) throw new Error(`sed: no output for ${name}`)
    return out
  }

  // A new input under -s or -i: line numbers, the hold space, ranges and `R`
  // readers start over.
  private restart(): void {
    this.line = 0
    this.hold = ''
    this.holdNewline = true
    this.ranges = new Map()
    this.begun = new Set()
    for (const reader of this.readers.values())
      if (reader instanceof Reader) this.stale.push(reader)
    this.readers = new Map()
    this.program.commands.forEach((cmd, index) => {
      const first = cmd.addr1
      if (
        first !== null &&
        cmd.addr2 !== null &&
        first.kind === AddressKind.LINE &&
        first.number === 0
      ) {
        this.ranges.set(index, 0)
        this.begun.add(index)
      }
    })
  }

  private async take(): Promise<Line | null> {
    const got = await this.feed.read()
    if (got === null) return null
    if (got.source !== this.source) {
      if (this.opts.separate && this.source !== -1) this.restart()
      this.source = got.source
    }
    this.line += 1
    this.replaced = false
    return got
  }

  private flushErrors(): void {
    if (this.errorOut.chunks.length === 0) return
    this.stderrParts.push(textView(this.errorOut.chunks.join(''), this.opts.utf8))
    this.errorOut.chunks.length = 0
  }

  /**
   * Run the script over `inputs` and yield what it prints. `inline` sends `w
   * /dev/stdout` into what is yielded; otherwise it collects in `stdout`
   * (-i). `flush` drains the `w` files, called after a cycle that wrote to one.
   */
  async *process(
    inputs: readonly SedInput[],
    inline: boolean,
    signal: AbortSignal | undefined,
    flush: () => Promise<void>,
  ): AsyncGenerator<string> {
    this.inline = inline
    this.out = new SedOutput()
    this.stdoutAlias = new SedOutput(this.out.chunks)
    this.source = -1
    if (this.opts.separate || !this.started) this.restart()
    this.started = true
    this.feed = new Feed(this, inputs)
    this.budget = new YieldBudget(signal)
    this.signal = signal
    try {
      yield* this.run(flush)
    } finally {
      // Inputs a `q` or a failure left unread, the `r` files a reader left
      // before their end and the `R` readers close here rather than staying
      // open.
      for (const given of inputs) await closeQuietly(given.source)
      const tails = this.tails
      this.tails = []
      for (const [, , tail] of tails) await closeQuietly(tail)
      await this.closeReaders()
    }
  }

  private async closeReaders(): Promise<void> {
    const readers = [...this.stale, ...this.readers.values()]
    this.readers = new Map()
    this.stale = []
    for (const reader of readers) if (reader instanceof Reader) await closeQuietly(reader.chunks)
  }

  private async *run(flush: () => Promise<void>): AsyncGenerator<string> {
    try {
      let line = await this.take()
      let pc = 0
      while (line !== null && !this.stopped()) {
        const again = await this.cycle(line, pc)
        pc = this.resume
        if ([...this.wfiles.values()].some((out) => out.chunks.length > 0)) await flush()
        this.flushErrors()
        if (this.full() || this.held()) yield* this.drain()
        if (again !== null) {
          line = again
          continue
        }
        if (this.stopped()) break
        line = await this.take()
      }
    } catch (err) {
      if (!(err instanceof Panic)) throw err
      this.stderrParts.push(err.message)
      this.panicCode = err.code
    }
    this.flushErrors()
    yield* this.drain()
  }

  // Whether what a loop has printed, to the output or to a `w` file, should go
  // out before it runs on.
  private full(): boolean {
    if (this.tails.length > 0 || this.out.chunks.length >= CHUNK) return true
    for (const out of this.wfiles.values()) if (out.chunks.length >= CHUNK) return true
    return false
  }

  // Whether output would wait behind a read that may wait.
  private held(): boolean {
    return (this.tails.length > 0 || this.out.chunks.length > 0) && this.feed.waits()
  }

  // Hand on what the run has printed, each `r` file streamed where it goes
  // out.
  private async *drain(): AsyncGenerator<string> {
    const chunks = this.out.chunks
    const tails = this.tails
    let at = 0
    for (const [index, [cut, name, tail]] of tails.entries()) {
      // The files not streamed yet stay where an early close of the run
      // finds them.
      this.tails = tails.slice(index)
      if (cut > at) yield chunks.slice(at, cut).join('')
      at = cut
      try {
        for (;;) {
          const next = await tail.next()
          if (next.done === true) break
          if (next.value.length > 0) yield byteView(next.value, this.opts.utf8)
        }
      } catch (err) {
        if (!isFsError(err)) throw err
        // GNU stops where the file fails: what was printed after it never
        // goes out.
        const failed = readError(name, err)
        this.stderrParts.push(failed.message)
        this.panicCode = failed.code
        for (const [, , rest] of tails.slice(index + 1)) await closeQuietly(rest)
        this.tails = []
        chunks.length = 0
        return
      } finally {
        await closeQuietly(tail)
      }
    }
    this.tails = []
    const rest = chunks.slice(at).join('')
    chunks.length = 0
    if (rest !== '') yield rest
  }

  private async isLast(): Promise<boolean> {
    return !(await this.feed.more(this.opts.separate))
  }

  // Whether `n` or `N` has a line to read: under -s only in the input they are
  // in, whose end is then theirs as the last input's would be, and sed goes on
  // with the next.
  private async more(): Promise<boolean> {
    return this.feed.more(this.opts.separate)
  }

  private regex(sedRegex: SedRegex): PosixRegex {
    const regex = sedRegex.regex
    if (regex === null) {
      if (this.last === null)
        throw new Panic('sed: -e expression #1, char 0: no previous regular expression\n', 1)
      return this.last
    }
    this.last = regex
    return regex
  }

  private async match(addr: SedAddress, ps: string): Promise<boolean> {
    switch (addr.kind) {
      case AddressKind.LINE:
        // `0r` is the one command line 0 addresses: it runs on the first
        // line, where the script reaches it.
        return this.line === Math.max(addr.number, 1)
      case AddressKind.LAST:
        return this.isLast()
      case AddressKind.REGEX:
        return addr.regex !== null && this.regex(addr.regex).search(ps) !== null
      case AddressKind.STEP:
        if (addr.step <= 0) return this.line === addr.number
        return this.line >= addr.number && (this.line - addr.number) % addr.step === 0
      default:
        return false
    }
  }

  private async inRange(index: number, cmd: SedCommand, ps: string): Promise<boolean> {
    const first = cmd.addr1
    const second = cmd.addr2
    if (first === null || second === null) return false
    const end = this.ranges.get(index)
    if (end !== undefined) {
      switch (second.kind) {
        case AddressKind.LINE:
          if (this.line >= second.number) {
            this.ranges.delete(index)
            return this.line === second.number
          }
          return true
        case AddressKind.PLUS:
          if (this.line >= end) this.ranges.delete(index)
          return true
        case AddressKind.MULTIPLE:
          if (second.number <= 0 || this.line % second.number === 0) this.ranges.delete(index)
          return true
        case AddressKind.STEP:
          if (await this.match(second, ps)) this.ranges.delete(index)
          return true
        case AddressKind.LAST:
          if (await this.isLast()) this.ranges.delete(index)
          return true
        default:
          if (second.regex !== null && this.regex(second.regex).search(ps) !== null)
            this.ranges.delete(index)
          return true
      }
    }
    if (first.kind === AddressKind.LINE) {
      // A range from a line number starts on the first line at or past it, so
      // one an `n` read over still opens, unless its numbered end has gone
      // by; it starts only once.
      if (this.begun.has(index) || this.line < first.number) return false
      if (this.line > first.number && second.kind === AddressKind.LINE && this.line > second.number)
        return false
      this.begun.add(index)
    } else if (!(await this.match(first, ps))) return false
    switch (second.kind) {
      case AddressKind.LINE:
        if (second.number > this.line) this.ranges.set(index, 0)
        break
      case AddressKind.PLUS:
        // A count read as negative is one past 2^63: its end wraps to a
        // line behind this one, or, wrapping below 0, never comes.
        if (second.number !== 0) {
          const end = this.line + second.number
          this.ranges.set(index, end < 0 ? Number.POSITIVE_INFINITY : end)
        }
        break
      case AddressKind.MULTIPLE:
        if (second.number > 0) this.ranges.set(index, 0)
        break
      case AddressKind.STEP:
        // Unlike `addr1,~N`, a `first~step` end can be the line that opens
        // the range.
        if (!(await this.match(second, ps))) this.ranges.set(index, 0)
        break
      case AddressKind.LAST:
        if (!(await this.isLast())) this.ranges.set(index, 0)
        break
      default:
        this.ranges.set(index, 0)
    }
    return true
  }

  private async applies(index: number, cmd: SedCommand, ps: string): Promise<boolean> {
    if (cmd.addr1 === null) return !cmd.negate
    const hit =
      cmd.addr2 === null ? await this.match(cmd.addr1, ps) : await this.inRange(index, cmd, ps)
    return hit !== cmd.negate
  }

  private async emitFile(name: string): Promise<void> {
    const content = this.opts.files.get(name) ?? null
    if (content === null) return
    if ('error' in content) throw new Panic(content.error, 4)
    if ('text' in content) {
      this.out.write(content.text)
      return
    }
    // The first piece is read here, where a directory fails as GNU reports
    // it; the rest streams out when the output gets to it. Every pull loses
    // to the abort, and a producer left mid-pull is closed without a wait.
    const stream = chunks(content.read(), this.signal, false)
    let first: Uint8Array = new Uint8Array()
    try {
      while (first.length === 0) {
        const next = await stream.next()
        if (next.done === true) return
        first = next.value
      }
    } catch (err) {
      await closeQuietly(stream)
      if (!isFsError(err)) throw err
      if (!opensFailed(err)) throw readError(name, err)
      // A file that cannot be opened reads as empty, as POSIX asks.
      console.debug(`sed r file ${name} does not open:`, err)
      return
    }
    this.out.write(byteView(first, this.opts.utf8))
    this.tails.push([this.out.chunks.length, name, stream])
  }

  // The next line of an `R` file, its newline kept.
  private async readerLine(name: string): Promise<string | null> {
    if (!this.readers.has(name)) {
      const content = this.opts.readerFiles.get(name) ?? null
      if (content !== null && 'error' in content) throw new Panic(content.error, 4)
      if (content === null) this.readers.set(name, null)
      else if ('text' in content) this.readers.set(name, cutLines(content.text).reverse())
      else
        this.readers.set(
          name,
          new Reader(chunks(content.read(), this.signal, false), this.opts.utf8, this),
        )
    }
    const reader = this.readers.get(name) ?? null
    if (reader === null) return null
    if (Array.isArray(reader)) return reader.pop() ?? null
    let got: [string, boolean] | null
    try {
      got = await reader.line()
    } catch (err) {
      if (!isFsError(err)) throw err
      this.readers.set(name, null)
      await closeQuietly(reader.chunks)
      if (!opensFailed(err) || reader.started) throw readError(name, err)
      // A file that cannot be opened reads as empty, as POSIX asks.
      console.debug(`sed R file ${name} does not open:`, err)
      return null
    }
    if (got === null) return null
    return got[0] + (got[1] ? '\n' : '')
  }

  private async dump(): Promise<void> {
    const queue = this.queue
    this.queue = []
    for (const [kind, value] of queue) {
      if (kind === 'file') await this.emitFile(value)
      else this.out.write(value)
    }
  }

  private list(ps: string, width: number): string {
    const pieces: string[] = []
    for (const byte of fromByteView(ps, this.opts.utf8)) {
      const escaped = ESCAPES[byte]
      if (escaped !== undefined) pieces.push(escaped)
      else if (byte >= 0x20 && byte < 0x7f) pieces.push(String.fromCharCode(byte))
      else pieces.push(`\\${byte.toString(8).padStart(3, '0')}`)
    }
    const out: string[] = []
    let used = 0
    const limit = width - 1
    for (const piece of pieces) {
      if (width > 0 && used + piece.length > limit) {
        out.push('\\\n')
        used = 0
      }
      out.push(piece)
      used += piece.length
    }
    out.push('$\n')
    return out.join('')
  }

  private expand(parts: readonly ReplacementPart[], ps: string, groups: Groups): string {
    const out: string[] = []
    let mode: string | null = null
    let pending: string | null = null
    let passed = 0
    for (const part of parts) {
      if (part.case !== null) {
        if (part.case === 'u' || part.case === 'l') {
          pending = part.case
          passed = 0
        } else {
          pending = null
          mode = part.case === 'E' ? null : part.case
        }
        continue
      }
      let text = part.text
      if (part.group !== null) {
        const span = groups[part.group] ?? null
        text = span === null ? '' : ps.slice(span[0], span[1])
      }
      if (mode !== null) text = this.changeCase(text, mode === 'U')
      if (pending !== null) {
        if (text !== '') {
          const first = String.fromCodePoint(text.codePointAt(0) ?? 0)
          text = this.changeCase(first, pending === 'u') + text.slice(first.length)
          pending = null
        } else {
          passed += 1
          if (passed > 1) pending = null
        }
      }
      out.push(text)
    }
    return out.join('')
  }

  private substitute(sub: SedSubstitution, ps: string): string | null {
    const regex = this.regex(sub.regex)
    if (sub.regex.regex === null) {
      // An empty expression's groups are known only now.
      const wanted = Math.max(0, ...sub.parts.map((part) => part.group ?? 0))
      if (wanted > regex.groups)
        throw new Panic(
          `sed: -e expression #1, char 0: invalid reference \\${String(wanted)} on \`s' command's RHS\n`,
          1,
        )
    }
    let found: Groups[]
    if (sub.global || sub.occurrence > 1) found = regex.all(ps)
    else {
      const one = regex.search(ps)
      found = one === null ? [] : [one]
    }
    const chosen = sub.global
      ? found.slice(sub.occurrence - 1)
      : found.slice(sub.occurrence - 1, sub.occurrence)
    if (chosen.length === 0) return null
    const out: string[] = []
    let at = 0
    for (const groups of chosen) {
      const whole = groups[0]
      if (whole === null || whole === undefined) continue
      out.push(ps.slice(at, whole[0]))
      out.push(this.expand(sub.parts, ps, groups))
      at = whole[1]
    }
    out.push(ps.slice(at))
    return out.join('')
  }

  // One cycle over `line` from command `pc`; the line to run again without
  // reading, from `resume`, or null. A loop that prints stops at its branch
  // once the output fills, and a command that may wait on the input stops
  // before it while output is held, so what was printed goes out first.
  private async cycle(line: Line, start: number): Promise<Line | null> {
    // A script that loops without reading still lets the loop run.
    await this.budget.run()
    this.resume = 0
    let reading = this.reading
    this.reading = false
    let ps = line.text
    let newline = line.newline
    const commands = this.program.commands
    const count = commands.length
    const printing = !this.quiet
    let pc = start
    const branch = async (target: number | null): Promise<Line | null> => {
      pc = target ?? count
      if (this.full()) {
        this.resume = pc
        return { text: ps, newline, source: line.source }
      }
      await this.budget.run()
      return null
    }
    loop: while (pc < count) {
      const cmd = commands[pc]
      if (cmd === undefined) break
      if (reading) {
        // The `n` this cycle stopped in, its address taken.
      } else if (this.reads[pc] === true && this.held()) {
        this.resume = pc
        return { text: ps, newline, source: line.source }
      } else if (!(await this.applies(pc, cmd, ps))) {
        pc = cmd.name === '{' ? cmd.blockEnd + 1 : pc + 1
        continue
      }
      pc += 1
      switch (cmd.name) {
        case '{':
        case '}':
        case ':':
          break
        case 'p':
          this.out.line(ps, newline)
          break
        case 's': {
          const sub = cmd.subst
          if (sub === null) break
          const result = this.substitute(sub, ps)
          if (result !== null) {
            ps = result
            this.replaced = true
            if (sub.print) this.out.line(ps, newline)
            if (sub.wfile !== null) this.output(sub.wfile).line(ps, newline)
          }
          break
        }
        case 'd':
          await this.dump()
          return null
        case 'D': {
          const cut = ps.indexOf('\n')
          if (cut < 0) {
            await this.dump()
            return null
          }
          // The cycle restarts without reading, and the appends wait for the
          // line it ends on.
          return { text: ps.slice(cut + 1), newline, source: line.source }
        }
        case 'b': {
          const paused = await branch(cmd.target)
          if (paused !== null) return paused
          break
        }
        case 't':
          if (this.replaced) {
            this.replaced = false
            const paused = await branch(cmd.target)
            if (paused !== null) return paused
          }
          break
        case 'T':
          if (!this.replaced) {
            const paused = await branch(cmd.target)
            if (paused !== null) return paused
          } else this.replaced = false
          break
        case 'n': {
          // GNU prints and appends whether or not a line follows.
          if (!reading) {
            if (printing) this.out.line(ps, newline)
            await this.dump()
            if (this.held()) {
              this.resume = pc - 1
              this.reading = true
              return { text: ps, newline, source: line.source }
            }
          }
          reading = false
          if (!(await this.more())) return null
          const got = await this.take()
          if (got === null) return null
          ps = got.text
          newline = got.newline
          break
        }
        case 'N': {
          if (!(await this.more())) break loop
          await this.dump()
          const got = await this.take()
          if (got === null) break loop
          ps = ps + '\n' + got.text
          newline = got.newline
          break
        }
        case 'a':
          if (cmd.text !== null) this.queue.push(['text', cmd.text])
          break
        case 'i':
          if (cmd.text !== null) this.out.write(cmd.text)
          break
        case 'c': {
          const ranged = cmd.addr2 !== null && !cmd.negate
          if ((!ranged || !this.ranges.has(pc - 1)) && cmd.text !== null) this.out.write(cmd.text)
          await this.dump()
          return null
        }
        case '=':
          this.out.write(`${String(this.line)}\n`)
          break
        case 'L':
          throw new Panic('sed: INTERNAL ERROR: Bad cmd L\n', 4)
        case 'l':
          this.out.write(this.list(ps, cmd.number ?? this.opts.lineLength))
          break
        case 'q':
          // `q` ends what it prints with a newline the input lacked.
          if (printing) this.out.line(ps, true)
          await this.dump()
          this.quitCode = quitCode(cmd.number)
          return null
        case 'Q':
          this.queue = []
          this.quitCode = quitCode(cmd.number)
          return null
        case 'r':
          if (cmd.filename === null) break
          // `0r` writes its file where it runs, ahead of the line.
          if (zeroLine(cmd)) await this.emitFile(cmd.filename)
          else this.queue.push(['file', cmd.filename])
          break
        case 'R':
          if (cmd.filename !== null) {
            const got = await this.readerLine(cmd.filename)
            if (got !== null) this.queue.push(['text', got])
          }
          break
        case 'w':
          if (cmd.filename !== null) this.output(cmd.filename).line(ps, newline)
          break
        case 'W': {
          if (cmd.filename === null) break
          const cut = ps.indexOf('\n')
          if (cut < 0) this.output(cmd.filename).line(ps, newline)
          else this.output(cmd.filename).line(ps.slice(0, cut), true)
          break
        }
        case 'P': {
          const cut = ps.indexOf('\n')
          if (cut < 0) this.out.line(ps, newline)
          else this.out.line(ps.slice(0, cut), true)
          break
        }
        case 'h':
          this.hold = ps
          this.holdNewline = newline
          break
        case 'H':
          this.hold = this.hold + '\n' + ps
          this.holdNewline = newline
          break
        case 'g':
          ps = this.hold
          newline = this.holdNewline
          break
        case 'G':
          ps = ps + '\n' + this.hold
          newline = this.holdNewline
          break
        case 'x':
          ;[ps, this.hold] = [this.hold, ps]
          ;[newline, this.holdNewline] = [this.holdNewline, newline]
          break
        case 'y': {
          const table = cmd.translit
          if (table === null) break
          let out = ''
          for (const ch of ps) out += table.get(ch) ?? ch
          ps = out
          break
        }
        case 'z':
          ps = ''
          break
        case 'F':
          // The input opened last, which a look-ahead may have moved past the
          // line's own.
          this.out.write(byteView(this.feed.name(this.feed.index), this.opts.utf8) + '\n')
          break
      }
    }
    if (printing) this.out.line(ps, newline)
    await this.dump()
    return null
  }
}
