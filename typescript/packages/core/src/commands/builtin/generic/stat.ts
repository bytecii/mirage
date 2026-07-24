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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import { isoToEpoch } from '../../../utils/dates.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { lsModeString } from '../utils/formatting.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()

const DEFAULT_OWNER = 'user'

const TYPE_LABELS: Record<string, string> = {
  [FileType.DIRECTORY]: 'directory',
  [FileType.TEXT]: 'regular file',
  [FileType.BINARY]: 'regular file',
  [FileType.JSON]: 'regular file',
  [FileType.CSV]: 'regular file',
}

function typeLabel(s: FileStat): string {
  return s.type ? (TYPE_LABELS[s.type] ?? 'regular file') : 'regular file'
}

function effectiveMode(s: FileStat): number {
  if (s.mode !== null) return s.mode & 0o7777
  return s.type === FileType.DIRECTORY ? 0o755 : 0o644
}

function typeBits(s: FileStat): number {
  return s.type === FileType.DIRECTORY ? 0o040000 : 0o100000
}

function owner(value: number | string | null): string {
  return value !== null ? String(value) : DEFAULT_OWNER
}

function epoch(iso: string | null): string {
  if (iso === null || iso === '') return '0'
  const secs = isoToEpoch(iso)
  return Number.isNaN(secs) ? '0' : String(secs)
}

function replaceSpec(spec: string, s: FileStat, name: string): string {
  if (spec === '%') return '%'
  if (spec === 'n') return name
  if (spec === 'N') return `'${name}'`
  if (spec === 's') return String(s.size ?? 0)
  if (spec === 'F') return typeLabel(s)
  if (spec === 'a') return effectiveMode(s).toString(8)
  if (spec === 'A') return lsModeString(s)
  if (spec === 'f') return (typeBits(s) | effectiveMode(s)).toString(16)
  if (spec === 'u' || spec === 'U') return owner(s.uid)
  if (spec === 'g' || spec === 'G') return owner(s.gid)
  if (spec === 'x') return s.atime ?? s.modified ?? ''
  if (spec === 'X') return epoch(s.atime ?? s.modified)
  if (spec === 'y' || spec === 'z') return s.modified ?? ''
  if (spec === 'Y' || spec === 'Z') return epoch(s.modified)
  if (spec === 'w') return '-'
  if (spec === 'W') return '0'
  if (spec === 'B') return '512'
  if (spec === 'r' || spec === 'R' || spec === 't' || spec === 'T') return '0'
  return '?'
}

function formatStat(fmt: string, s: FileStat, name: string): string {
  return fmt.replace(/%([\s\S])/g, (_, spec: string) => replaceSpec(spec, s, name))
}

export async function statGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stat: (p: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('stat: missing operand\n') })]
  }
  const fmt =
    typeof opts.flags.c === 'string'
      ? opts.flags.c
      : typeof opts.flags.f === 'string'
        ? opts.flags.f
        : null
  const lines: string[] = []
  let err = ''
  for (const p of paths) {
    let s: FileStat
    try {
      s = await stat(p)
    } catch (e) {
      // GNU stat keeps reporting the remaining operands, exit 1.
      if (!isFsError(e)) throw e
      err += fsErrorLine('stat', p, e)
      continue
    }
    if (fmt !== null) {
      lines.push(formatStat(fmt, s, p.rawPath))
    } else {
      const sizeStr = s.size === null ? 'None' : String(s.size)
      const modStr = s.modified ?? 'None'
      const typeStr = s.type ?? 'None'
      lines.push(`name=${s.name} size=${sizeStr} modified=${modStr} type=${typeStr}`)
    }
  }
  const io = new IOResult({
    exitCode: err === '' ? 0 : 1,
    stderr: err === '' ? null : ENC.encode(err),
  })
  if (lines.length === 0) return [null, io]
  const out: ByteSource = formatRecords(lines)
  return [out, io]
}
