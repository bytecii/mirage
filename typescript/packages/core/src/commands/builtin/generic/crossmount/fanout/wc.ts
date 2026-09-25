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

import type { ByteSource } from '../../../../../io/types.ts'
import { formatCountRows, numberWidth, parseFlags, shownCounts, type WcRow } from '../../wc.ts'
import type { OperandRun } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

// GNU prints a row's counts in this order whichever flags ask for them.
const COLUMNS = ['lines', 'words', 'chars', 'bytes', 'maxLineLength'] as const
type Column = (typeof COLUMNS)[number]

// Re-total per-operand wc rows with one shared column width. Each native run
// right-aligns its own rows against its own operands, so the runs cannot
// simply concatenate: rows are re-parsed and the whole report is reformatted
// by the same formatter the single-mount command uses, which is also what
// applies --total. runFanout forces the native runs to --total=never and to
// count bytes, so every line read here is a file row that carries its file's
// size, which is what GNU sizes the columns by; a byte column nobody asked for
// is not shown. Mirrors Python's combine_wc.
export function combineWc(
  results: OperandRun[],
  flagKwargs: Record<string, FlagValue>,
): ByteSource | null {
  const parsed = parseFlags(flagKwargs)
  if (typeof parsed === 'string') return null
  const asked = parsed.lines || parsed.words || parsed.bytes || parsed.chars || parsed.maxLineLength
  const shown: Record<Column, boolean> = {
    lines: parsed.lines || !asked,
    words: parsed.words || !asked,
    chars: parsed.chars,
    bytes: parsed.bytes || !asked,
    maxLineLength: parsed.maxLineLength,
  }
  const read = COLUMNS.filter((c) => shown[c] || c === 'bytes')
  const rows: WcRow[] = []
  const sizes: (number | null)[] = []
  const total = new Map<Column, number>(read.map((c) => [c, 0]))
  for (const run of results) {
    for (const line of DEC.decode(run.data).split('\n')) {
      if (line === '') continue
      const parts = line.trim().split(/\s+/)
      const values = new Map<Column, number>(read.map((c, i) => [c, parseInt(parts[i] ?? '0', 10)]))
      const labelText = parts.slice(read.length).join(' ')
      const label = labelText === '' ? null : labelText
      rows.push({ values: COLUMNS.filter((c) => shown[c]).map((c) => values.get(c) ?? 0), label })
      sizes.push(label === '-' || label === '/dev/stdin' ? null : (values.get('bytes') ?? 0))
      for (const c of read) {
        const v = values.get(c) ?? 0
        const t = total.get(c) ?? 0
        total.set(c, c === 'maxLineLength' ? Math.max(t, v) : t + v)
      }
    }
  }
  // GNU decides the auto total on the operands *given*, not on the rows that
  // resolved, so a missing operand still gets a total row. There are always at
  // least two scopes here, and a glob operand can expand to more.
  const operands = Math.max(rows.length, results.length)
  const width = numberWidth(sizes, operands, shownCounts(parsed))
  const totalValues = COLUMNS.filter((c) => shown[c]).map((c) => total.get(c) ?? 0)
  return formatCountRows(rows, totalValues, operands, parsed.total, width)
}
