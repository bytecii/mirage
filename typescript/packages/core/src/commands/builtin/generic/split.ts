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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { UsageError } from '../../errors.ts'
import { sizeSuffixes } from '../utils/size_suffix.ts'

const ENC = new TextEncoder()

// GNU split's letter set: every uppercase power letter plus b, and
// lowercase k/m only (pinned against coreutils 9.7). Unlike od, split is
// base-10 only: hex and octal spellings are invalid numbers.
const BYTE_UNITS = sizeSuffixes('bkKmMEGPQRTYZ')
const BYTE_SUFFIXES = Object.keys(BYTE_UNITS).sort((a, b) => b.length - a.length)
const DIGITS = /^\d+$/
const HEX_DIGITS = /^[0-9a-fA-F]+$/
const TRY_HELP = "\nTry 'split --help' for more information."

function parseBytesValue(value: string): number {
  const suffix = BYTE_SUFFIXES.find((u) => value.endsWith(u))
  const digits = suffix === undefined ? value : value.slice(0, -suffix.length)
  if (!DIGITS.test(digits) || Number.parseInt(digits, 10) === 0) {
    throw new UsageError(`split: invalid number of bytes: '${value}'`, 1)
  }
  return Number.parseInt(digits, 10) * (suffix === undefined ? 1 : (BYTE_UNITS[suffix] ?? 1))
}

function parseLinesValue(value: string): number {
  if (!DIGITS.test(value) || Number.parseInt(value, 10) === 0) {
    throw new UsageError(`split: invalid number of lines: '${value}'`, 1)
  }
  return Number.parseInt(value, 10)
}

// GNU quotes only the N of an `l/N` or `K/N` chunk spec in the error.
function parseChunksValue(value: string): number {
  const tail = value.split('/').at(-1) ?? value
  if (!DIGITS.test(tail) || Number.parseInt(tail, 10) === 0) {
    throw new UsageError(`split: invalid number of chunks: '${tail}'`, 1)
  }
  return Number.parseInt(tail, 10)
}

function parseSuffixLength(value: string): number {
  if (!DIGITS.test(value)) {
    throw new UsageError(`split: invalid suffix length: '${value}'`, 1)
  }
  return Number.parseInt(value, 10)
}

function parseSuffixStart(value: string, hexMode: boolean, suffixLen: number): number {
  if (!(hexMode ? HEX_DIGITS : DIGITS).test(value)) {
    const kind = hexMode ? 'hexadecimal' : 'numerical'
    throw new UsageError(`split: '${value}': invalid start value for ${kind} suffix${TRY_HELP}`, 1)
  }
  const start = Number.parseInt(value, hexMode ? 16 : 10)
  if (start.toString(hexMode ? 16 : 10).length > suffixLen) {
    throw new UsageError(
      `split: numerical suffix start value is too large for the suffix length${TRY_HELP}`,
      1,
    )
  }
  return start
}

function alphaSuffix(index: number, length: number): string {
  const chars: string[] = []
  let n = index
  for (let i = 0; i < length; i++) {
    chars.push(String.fromCharCode('a'.charCodeAt(0) + (n % 26)))
    n = Math.floor(n / 26)
  }
  return chars.reverse().join('')
}

function numericSuffix(index: number, length: number): string {
  const s = String(index)
  return s.length >= length ? s : '0'.repeat(length - s.length) + s
}

function hexSuffix(index: number, length: number): string {
  return index.toString(16).padStart(length, '0')
}

function makePathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
    resolved: true,
  })
}

function outputPath(
  prefix: string,
  suffix: (index: number, length: number) => string,
  index: number,
  start: number,
  length: number,
  additional: string,
): string {
  return prefix + suffix(index + start, length) + additional
}

function joinLines(lines: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const l of lines) total += l.byteLength + 1
  const out = new Uint8Array(total)
  let offset = 0
  for (const l of lines) {
    out.set(l, offset)
    offset += l.byteLength
    out[offset] = 0x0a
    offset += 1
  }
  return out
}

async function* recordIterator(
  source: AsyncIterable<Uint8Array>,
  separator: number,
): AsyncIterable<Uint8Array> {
  let pending = new Uint8Array(0)
  for await (const chunk of source) {
    const merged = new Uint8Array(pending.byteLength + chunk.byteLength)
    merged.set(pending)
    merged.set(chunk, pending.byteLength)
    let start = 0
    for (let index = 0; index < merged.byteLength; index++) {
      if (merged[index] === separator) {
        yield merged.slice(start, index)
        start = index + 1
      }
    }
    pending = merged.slice(start)
  }
  if (pending.byteLength > 0) yield pending
}

function joinRecords(records: readonly Uint8Array[], separator: number): Uint8Array {
  if (separator === 0x0a) return joinLines(records)
  let total = records.length
  for (const record of records) total += record.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const record of records) {
    out.set(record, offset)
    offset += record.byteLength
    out[offset] = separator
    offset += 1
  }
  return out
}

export async function splitGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('split'))
  if (paths.length > 2) throw extraOperandError(CommandName.SPLIT, paths[2]?.rawPath ?? '')
  const prefixPath = paths.length >= 2 && paths[1] !== undefined ? paths[1].mountPath : 'x'
  const linesValue = fl.asStr('lines')
  const bytesValue = fl.asStr('bytes')
  const numberValue = fl.asStr('number')
  const lengthValue = fl.asStr('suffix_length')
  const numericValue = fl.raw('numeric_suffixes')
  const hexValue = fl.raw('hex_suffixes')
  const separatorValue = fl.asStr('separator')
  const linesFlag = typeof linesValue === 'string' ? linesValue : null
  const bFlag = typeof bytesValue === 'string' ? bytesValue : null
  const nFlag = typeof numberValue === 'string' ? numberValue : null
  const aFlag = typeof lengthValue === 'string' ? lengthValue : null
  const dFlag = numericValue !== undefined
  const xFlag = hexValue !== undefined
  const suffixLenRaw = aFlag !== null ? parseSuffixLength(aFlag) : 2
  // GNU reads an explicit `-a 0` as "revert to auto width", which for
  // fixed-width naming is the default length of 2.
  const suffixLen = suffixLenRaw === 0 ? 2 : suffixLenRaw
  const suffixStart =
    typeof numericValue === 'string'
      ? parseSuffixStart(numericValue, false, suffixLen)
      : typeof hexValue === 'string'
        ? parseSuffixStart(hexValue, true, suffixLen)
        : 0
  const additionalSuffix = fl.asStr('additional_suffix') ?? ''
  const separator =
    separatorValue === '\\0'
      ? 0
      : typeof separatorValue === 'string'
        ? (ENC.encode(separatorValue)[0] ?? 0x0a)
        : 0x0a
  const linesPerFile =
    linesFlag !== null ? parseLinesValue(linesFlag) : bFlag === null && nFlag === null ? 1000 : 0
  const byteLimit = bFlag !== null ? parseBytesValue(bFlag) : 0
  const nChunks = nFlag !== null ? parseChunksValue(nFlag) : 0
  const suffixFn = xFlag ? hexSuffix : dFlag ? numericSuffix : alphaSuffix

  let source: AsyncIterable<Uint8Array>
  const first = paths[0]
  if (first !== undefined) {
    source = stream(first)
  } else {
    source = resolveSource(opts.stdin)
  }

  const writes: Record<string, Uint8Array> = {}
  let fileIdx = 0

  if (nChunks > 0) {
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const c of source) {
      chunks.push(c)
      total += c.byteLength
    }
    const allData = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      allData.set(c, offset)
      offset += c.byteLength
    }
    const chunkSize = Math.max(1, Math.ceil(total / nChunks))
    offset = 0
    for (let i = 0; i < nChunks; i++) {
      const part = allData.slice(offset, offset + chunkSize)
      if (part.byteLength === 0) break
      const outPath = outputPath(prefixPath, suffixFn, i, suffixStart, suffixLen, additionalSuffix)
      await write(makePathSpec(outPath), part)
      writes[outPath] = part
      offset += chunkSize
    }
  } else if (byteLimit > 0) {
    let buf = new Uint8Array(0)
    for await (const c of source) {
      const merged = new Uint8Array(buf.byteLength + c.byteLength)
      merged.set(buf, 0)
      merged.set(c, buf.byteLength)
      buf = merged
      while (buf.byteLength >= byteLimit) {
        const outPath = outputPath(
          prefixPath,
          suffixFn,
          fileIdx,
          suffixStart,
          suffixLen,
          additionalSuffix,
        )
        const data = buf.slice(0, byteLimit)
        await write(makePathSpec(outPath), data)
        writes[outPath] = data
        buf = buf.slice(byteLimit)
        fileIdx += 1
      }
    }
    if (buf.byteLength > 0) {
      const outPath = outputPath(
        prefixPath,
        suffixFn,
        fileIdx,
        suffixStart,
        suffixLen,
        additionalSuffix,
      )
      await write(makePathSpec(outPath), buf)
      writes[outPath] = buf
    }
  } else {
    const lineBuf: Uint8Array[] = []
    const iter =
      separator === 0x0a ? new AsyncLineIterator(source) : recordIterator(source, separator)
    for await (const line of iter) {
      lineBuf.push(line)
      if (lineBuf.length >= linesPerFile) {
        const outPath = outputPath(
          prefixPath,
          suffixFn,
          fileIdx,
          suffixStart,
          suffixLen,
          additionalSuffix,
        )
        const data = joinRecords(lineBuf, separator)
        await write(makePathSpec(outPath), data)
        writes[outPath] = data
        lineBuf.length = 0
        fileIdx += 1
      }
    }
    if (lineBuf.length > 0) {
      const outPath = outputPath(
        prefixPath,
        suffixFn,
        fileIdx,
        suffixStart,
        suffixLen,
        additionalSuffix,
      )
      const data = joinRecords(lineBuf, separator)
      await write(makePathSpec(outPath), data)
      writes[outPath] = data
    }
  }
  return [null, new IOResult({ writes })]
}
