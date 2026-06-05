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

import { materialize } from '../../io/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export const CUT_OPEN_END = Number.MAX_SAFE_INTEGER

export function parseCutRanges(spec: string): [number, number][] {
  const ranges: [number, number][] = []
  for (const part of spec.split(',')) {
    if (part.includes('-')) {
      const [loStr, hiStr] = part.split('-', 2) as [string, string]
      const lo = loStr === '' ? 1 : Number.parseInt(loStr, 10)
      const hi = hiStr === '' ? CUT_OPEN_END : Number.parseInt(hiStr, 10)
      ranges.push([lo, hi])
    } else {
      const val = Number.parseInt(part, 10)
      ranges.push([val, val])
    }
  }
  return ranges
}

function selectPositions(
  ranges: readonly [number, number][],
  n: number,
  complement: boolean,
): number[] {
  const inSet = new Set<number>()
  for (const [lo, hi] of ranges) {
    const start = Math.max(1, lo)
    const end = Math.min(hi, n)
    for (let p = start; p <= end; p++) inSet.add(p)
  }
  const out: number[] = []
  for (let p = 1; p <= n; p++) {
    if (complement ? !inSet.has(p) : inSet.has(p)) out.push(p)
  }
  return out
}

function withSep(rec: Uint8Array, sep: number): Uint8Array {
  const out = new Uint8Array(rec.byteLength + 1)
  out.set(rec, 0)
  out[rec.byteLength] = sep
  return out
}

function splitRecords(raw: Uint8Array, sep: number): Uint8Array[] {
  const records: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < raw.byteLength; i++) {
    if (raw[i] === sep) {
      records.push(raw.subarray(start, i))
      start = i + 1
    }
  }
  if (start < raw.byteLength) records.push(raw.subarray(start))
  return records
}

function cutRecord(
  rec: Uint8Array,
  delimiter: string,
  fieldRanges: readonly [number, number][] | null,
  charRanges: readonly [number, number][] | null,
  complement: boolean,
  sep: number,
): Uint8Array {
  const line = DEC.decode(rec)
  if (charRanges !== null) {
    const positions = selectPositions(charRanges, line.length, complement)
    let s = ''
    for (const p of positions) s += line.charAt(p - 1)
    return withSep(ENC.encode(s), sep)
  }
  if (fieldRanges !== null) {
    const parts = line.split(delimiter)
    if (parts.length === 1) return withSep(rec, sep)
    const positions = selectPositions(fieldRanges, parts.length, complement)
    const selected = positions.map((p) => parts[p - 1] ?? '')
    return withSep(ENC.encode(selected.join(delimiter)), sep)
  }
  return withSep(rec, sep)
}

export async function* cutStream(
  source: AsyncIterable<Uint8Array>,
  delimiter: string,
  fieldRanges: readonly [number, number][] | null,
  charRanges: readonly [number, number][] | null,
  complement: boolean,
  zeroTerminated: boolean,
): AsyncIterable<Uint8Array> {
  const raw = await materialize(source)
  const sep = zeroTerminated ? 0 : 0x0a
  for (const rec of splitRecords(raw, sep)) {
    yield cutRecord(rec, delimiter, fieldRanges, charRanges, complement, sep)
  }
}

export function cutBytes(
  raw: Uint8Array,
  delimiter: string,
  fieldRanges: readonly [number, number][] | null,
  charRanges: readonly [number, number][] | null,
  complement: boolean,
  zeroTerminated: boolean,
): Uint8Array {
  const sep = zeroTerminated ? 0 : 0x0a
  const parts = splitRecords(raw, sep).map((rec) =>
    cutRecord(rec, delimiter, fieldRanges, charRanges, complement, sep),
  )
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}
