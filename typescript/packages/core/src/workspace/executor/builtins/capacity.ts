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

import { humanSize } from '../../../commands/builtin/utils/formatting.ts'
import { IOResult } from '../../../io/types.ts'
import { CapacityState, PathSpec } from '../../../types.ts'
import type { CapacityResult } from '../../../types.ts'
import { resolvePath } from '../../../utils/path.ts'
import type { MountEntry } from '../../mount/mount.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import { splitValueFlags } from './metadata.ts'
import type { Result } from './scope.ts'

const SI_UNITS = ['B', 'K', 'M', 'G', 'T']
const BLOCK_SUFFIX: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
}

function errorResult(message: string, exitCode: number): Result {
  const err = new TextEncoder().encode(message)
  return [
    null,
    new IOResult({ exitCode, stderr: err }),
    new ExecutionNode({ command: 'df', exitCode, stderr: err }),
  ]
}

function textResult(out: string): Result {
  return [
    new TextEncoder().encode(out),
    new IOResult(),
    new ExecutionNode({ command: 'df', exitCode: 0 }),
  ]
}

// Parse a -B/--block-size argument into [bytes, header-label]; a plain byte
// count or a 1024-based suffix (K/M/G/T), labelled after the raw argument.
function parseBlock(text: string): [number, string] | null {
  const t = text.trim()
  if (t.length === 0) return null
  const suffix = t.slice(-1).toUpperCase()
  if (suffix in BLOCK_SUFFIX) {
    const head = t.slice(0, -1) || '1'
    if (!/^\d+$/.test(head)) return null
    return [parseInt(head, 10) * (BLOCK_SUFFIX[suffix] ?? 1), t]
  }
  if (!/^\d+$/.test(t)) return null
  return [parseInt(t, 10), t]
}

// Human-readable size in powers of 1000 (df -H), mirroring the 1024
// `humanSize` shape used by df -h / du -h.
function humanSi(n: number): string {
  let value = n
  let i = 0
  while (value >= 1000 && i < SI_UNITS.length - 1) {
    value /= 1000
    i += 1
  }
  const text = i === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${text}${SI_UNITS[i] ?? ''}`
}

// Bytes as a count of `block`-byte units, rounded up like GNU df.
function scale(nbytes: number, block: number): string {
  return String(Math.ceil(nbytes / block))
}

// GNU df use-percent: ceil(used / (used + avail) * 100), or `-` when the
// denominator is zero.
function usePct(used: number, avail: number): string {
  const denom = used + avail
  if (denom <= 0) return '-'
  return `${String(Math.ceil((used * 100) / denom))}%`
}

// The three numeric cells (block or inode) for one mount, or three `-` when
// capacity is not a known quota (never a fabricated 0).
function numCells(
  cap: CapacityResult,
  human: boolean,
  si: boolean,
  block: number,
  inodes: boolean,
): string[] {
  const quota = cap.state === CapacityState.QUOTA
  if (inodes) {
    if (quota && cap.inodes != null) {
      return [String(cap.inodes), String(cap.inodesUsed ?? 0), String(cap.inodesFree ?? 0)]
    }
    return ['-', '-', '-']
  }
  if (quota && cap.total != null) {
    const used = cap.used ?? 0
    const avail = cap.available ?? 0
    if (human) {
      const fmt = si ? humanSi : humanSize
      return [fmt(cap.total), fmt(used), fmt(avail)]
    }
    return [scale(cap.total, block), scale(used, block), scale(avail, block)]
  }
  return ['-', '-', '-']
}

// The Use%/IUse% cell for one mount, or `-` outside a known quota.
function pctCell(cap: CapacityResult, inodes: boolean): string {
  if (cap.state !== CapacityState.QUOTA) return '-'
  if (inodes) {
    if (cap.inodes == null) return '-'
    return usePct(cap.inodesUsed ?? 0, cap.inodesFree ?? 0)
  }
  if (cap.total == null) return '-'
  return usePct(cap.used ?? 0, cap.available ?? 0)
}

// Resolve df operands to the mounts to report, deduped and ordered. No
// operand (or the workspace root `/`) reports every mount; a path operand
// reports the mount containing it. Null when an operand maps to no mount.
function targetMounts(
  registry: MountRegistry,
  session: Session,
  operands: (string | PathSpec)[],
): MountEntry[] | { missing: string } {
  const ordered = [...registry.allMounts()].sort((a, b) => a.prefix.localeCompare(b.prefix))
  if (operands.length === 0) return ordered
  const seen = new Set<string>()
  const out: MountEntry[] = []
  for (const op of operands) {
    const virtual = op instanceof PathSpec ? op.virtual : resolvePath(op, session.cwd)
    if (virtual === '' || virtual === '/') {
      for (const m of ordered) {
        if (!seen.has(m.prefix)) {
          seen.add(m.prefix)
          out.push(m)
        }
      }
      continue
    }
    const mount = registry.mountFor(virtual)
    if (mount === null) {
      return { missing: op instanceof PathSpec ? op.rawPath : op }
    }
    if (!seen.has(mount.prefix)) {
      seen.add(mount.prefix)
      out.push(mount)
    }
  }
  return out
}

// GNU df column layout: Filesystem left-justified (min width 14), Type (when
// present) left, numeric columns right-justified, Mounted on left with no
// trailing pad, single-space separators.
function renderTable(header: string[], rows: string[][], showType: boolean): string {
  const ncols = header.length
  const left = new Set<number>([0, ncols - 1])
  if (showType) left.add(1)
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length), 0),
  )
  widths[0] = Math.max(widths[0] ?? 0, 14)
  const lines: string[] = []
  for (const cells of [header, ...rows]) {
    const parts: string[] = []
    for (let c = 0; c < ncols; c++) {
      const cell = cells[c] ?? ''
      const w = widths[c] ?? 0
      if (c === ncols - 1) parts.push(cell)
      else if (left.has(c)) parts.push(cell.padEnd(w))
      else parts.push(cell.padStart(w))
    }
    lines.push(parts.join(' '))
  }
  return lines.join('\n') + '\n'
}

// df [OPTION]... [FILE]...: report per-mount capacity. A mount reports real
// numbers only when its backend can; every other backend shows `-` rather
// than a fabricated total.
export async function handleDf(
  registry: MountRegistry,
  session: Session,
  args: (string | PathSpec)[],
): Promise<Result> {
  const { flags, values, operands, bad } = splitValueFlags(args, 'hHkiaTP', 'B')
  if (bad !== null) return errorResult(`df: invalid option -- '${bad}'\n`, 2)

  const posix = flags.has('P')
  let block = 1024
  let blockLabel = posix ? '1024-blocks' : '1K-blocks'
  const bArg = values.get('B')
  if (bArg !== undefined) {
    const parsed = parseBlock(bArg)
    if (parsed === null) return errorResult(`df: invalid --block-size argument '${bArg}'\n`, 1)
    block = parsed[0]
    blockLabel = `${parsed[1]}-blocks`
  }

  const si = flags.has('H')
  const human = si || flags.has('h')
  const inodes = flags.has('i')
  const showType = flags.has('T')

  const mounts = targetMounts(registry, session, operands)
  if (!Array.isArray(mounts)) {
    return errorResult(`df: ${mounts.missing}: No such file or directory\n`, 1)
  }

  let numHeaders: string[]
  let pctHeader: string
  if (inodes) {
    numHeaders = ['Inodes', 'IUsed', 'IFree']
    pctHeader = 'IUse%'
  } else if (human) {
    numHeaders = ['Size', 'Used', 'Avail']
    pctHeader = 'Use%'
  } else {
    numHeaders = [blockLabel, 'Used', 'Available']
    pctHeader = posix ? 'Capacity' : 'Use%'
  }

  const header = ['Filesystem']
  if (showType) header.push('Type')
  header.push(...numHeaders, pctHeader, 'Mounted on')

  const data: string[][] = []
  for (const mount of mounts) {
    const cap = mount.resource.statfs
      ? await mount.resource.statfs()
      : { state: CapacityState.UNKNOWN }
    const cells = [mount.resource.kind]
    if (showType) cells.push(mount.resource.kind)
    cells.push(...numCells(cap, human, si, block, inodes))
    cells.push(pctCell(cap, inodes))
    cells.push(mount.prefix.replace(/\/+$/, '') || '/')
    data.push(cells)
  }

  return textResult(renderTable(header, data, showType))
}
