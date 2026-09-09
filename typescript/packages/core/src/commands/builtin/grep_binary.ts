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

import { byteChar, encodeText } from '../../shell/bytes.ts'
import { closeQuietly } from '../../io/stream.ts'
import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { concat } from '../../io/cachable_iterator.ts'
import type { IOResult } from '../../io/types.ts'
import type { WalkFilters } from './grep_select.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { ignoreBOM: true })

export interface FlagSet {
  filters: WalkFilters
  binaryMode: string
  recursive: boolean
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  wholeWord: boolean
  fixedString: boolean
  basicRegexp: boolean
  onlyMatching: boolean
  maxCount: number | null
  quiet: boolean
  withFilename: boolean
  noFilename: boolean
  afterContext: number
  beforeContext: number
}

// GNU grep's INITIAL_BUFSIZE: the window it examines before printing from it.
export const PROBE_BLOCK_BYTES = 96 * 1024

export class BinaryInput {
  nul = false
  constructor(readonly mode: string) {}

  /**
   * Regroup the transport's chunks into GNU-sized probe blocks. GNU reads a
   * whole buffer before printing from it, so a NUL anywhere in the window
   * suppresses the lines ahead of it however the transport chunked them. A
   * NUL is acted on the moment it arrives, and nothing past the block the
   * scanner asked for is read.
   */
  async *read(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    let pending: Uint8Array[] = []
    let size = 0
    for await (const chunk of source) {
      pending.push(chunk)
      size += chunk.length
      if (size < PROBE_BLOCK_BYTES) {
        // Still inside one block, so a NUL here is that block's.
        if (this.stops(chunk)) return
        continue
      }
      const data = concat(pending)
      const whole = data.length - (data.length % PROBE_BLOCK_BYTES)
      for (let offset = 0; offset < whole; offset += PROBE_BLOCK_BYTES) {
        const block = data.subarray(offset, offset + PROBE_BLOCK_BYTES)
        if (this.stops(block)) return
        yield this.deliver(block)
      }
      const rest = data.subarray(whole)
      pending = rest.length > 0 ? [rest] : []
      size = rest.length
      if (rest.length > 0 && this.stops(rest)) return
    }
    if (size > 0) yield this.deliver(concat(pending))
  }

  // Note a NUL in data, which all belongs to the block being probed; true
  // when without-match must stop reading.
  private stops(data: Uint8Array): boolean {
    if (this.mode !== 'text' && !this.nul && data.includes(0)) this.nul = true
    return this.nul && this.mode === 'without-match'
  }

  private deliver(block: Uint8Array): Uint8Array {
    return this.nul ? block.map((byte) => (byte === 0 ? 10 : byte)) : block
  }
}

export function validUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return false
  }
}

function outputLine(
  raw: Uint8Array,
  number: number,
  selected: boolean,
  path: string,
  showFilename: boolean,
  f: FlagSet,
): Uint8Array {
  const separator = selected ? ':' : '-'
  const prefix = ENC.encode(
    (showFilename ? path + separator : '') + (f.lineNumbers ? String(number) + separator : ''),
  )
  const out = new Uint8Array(prefix.length + raw.length + 1)
  out.set(prefix)
  out.set(raw, prefix.length)
  out[out.length - 1] = 10
  return out
}

export async function* grepInput(
  source: AsyncIterable<Uint8Array>,
  pat: RegExp,
  f: FlagSet,
  path: string,
  showFilename: boolean,
  io: IOResult,
  // Whether an earlier input already printed lines; GNU then opens this
  // input's first context group with the separator, as it does between
  // groups within one input.
  afterOutput = false,
): AsyncIterable<Uint8Array> {
  io.exitCode = 1
  pat = utf8Pattern(pat)
  const binary = new BinaryInput(f.binaryMode)
  let count = 0
  let notified = false
  const previous: [number, Uint8Array][] = []
  let lastPrinted = 0
  let afterUntil = 0
  const hasContext = (f.afterContext > 0 || f.beforeContext > 0) && !f.onlyMatching
  if (f.maxCount === 0) {
    if (f.countOnly && !(f.quiet || f.filesOnly))
      yield ENC.encode((showFilename ? path + ':' : '') + '0\n')
    return
  }
  let number = 0
  const input = binary.read(source)
  try {
    for await (const raw of new AsyncLineIterator(input)) {
      if (binary.nul && f.binaryMode === 'without-match') break
      number += 1
      const line = decodeLine(raw)
      let hit = pat.test(line) !== f.invert
      if (f.maxCount !== null && count >= f.maxCount) hit = false
      if (hit) {
        count += 1
        io.exitCode = 0
        if (f.quiet) return
        if (f.filesOnly) {
          yield ENC.encode(path + '\n')
          return
        }
      }
      if (f.countOnly) {
        if (f.maxCount !== null && count >= f.maxCount) break
        continue
      }
      const chunks: Uint8Array[] = []
      if (hit) {
        if (f.onlyMatching) {
          if (!f.invert) {
            const re = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g')
            for (const m of line.matchAll(re)) {
              if (m[0] !== '')
                chunks.push(outputLine(encodeText(m[0]), number, true, path, showFilename, f))
            }
          }
        } else {
          if (hasContext) {
            const pending = previous.filter(([n]) => n > lastPrinted)
            const first = pending[0]?.[0] ?? number
            if ((lastPrinted && first > lastPrinted + 1) || (!lastPrinted && afterOutput))
              chunks.push(ENC.encode('--\n'))
            for (const [n, data] of pending)
              chunks.push(outputLine(data, n, false, path, showFilename, f))
          }
          chunks.push(outputLine(raw, number, true, path, showFilename, f))
          lastPrinted = number
          afterUntil = number + f.afterContext
        }
      } else if (hasContext && number <= afterUntil) {
        chunks.push(outputLine(raw, number, false, path, showFilename, f))
        lastPrinted = number
      }
      for (const chunk of chunks) {
        if (f.binaryMode !== 'text' && (binary.nul || !validUtf8(chunk))) {
          if (f.binaryMode === 'binary' && !notified) {
            const old = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
            const notice = ENC.encode(`grep: ${path}: binary file matches\n`)
            const err = new Uint8Array(old.length + notice.length)
            err.set(old)
            err.set(notice, old.length)
            io.stderr = err
            notified = true
          }
          continue
        }
        yield chunk
      }
      if (binary.nul && count && f.binaryMode === 'binary') return
      previous.push([number, raw])
      if (previous.length > f.beforeContext) previous.shift()
      if (f.maxCount !== null && count >= f.maxCount && number >= afterUntil) break
    }
  } finally {
    await closeQuietly(input)
    await closeQuietly(source)
  }

  // Detection can end input without yielding another line.
  if (binary.nul && f.binaryMode === 'without-match') {
    count = 0
    io.exitCode = 1
  }

  if (f.countOnly && !(f.quiet || f.filesOnly))
    yield ENC.encode((showFilename ? path + ':' : '') + String(count) + '\n')
}

function decodeLine(raw: Uint8Array): string {
  if (validUtf8(raw)) return DEC.decode(raw)
  let text = ''
  for (let i = 0; i < raw.length; ) {
    const byte = raw[i]
    if (byte === undefined) break
    const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4
    const part = raw.subarray(i, i + width)
    if (part.length === width && validUtf8(part)) {
      text += DEC.decode(part)
      i += width
    } else {
      text += byteChar(byte)
      i += 1
    }
  }
  return text
}

function utf8Pattern(pat: RegExp): RegExp {
  let pattern = ''
  let escaped = false
  let inClass = false
  let classStart = 0
  for (let index = 0; index < pat.source.length; index += 1) {
    const char = pat.source.charAt(index)
    if (escaped) {
      pattern += char
      escaped = false
    } else if (char === '\\') {
      pattern += char
      escaped = true
    } else if (char === '[' && !inClass) {
      pattern += char
      inClass = true
      // A leading ] after an optional ^ is a class member.
      classStart = index + 1
      if (pat.source.charAt(classStart) === '^') classStart += 1
    } else if (char === ']' && inClass && index > classStart) {
      pattern += char
      inClass = false
    } else if (char === '.' && !inClass) pattern += '[^\\n\\udc80-\\udcff]'
    else pattern += char
  }
  return new RegExp(pattern, pat.flags)
}
