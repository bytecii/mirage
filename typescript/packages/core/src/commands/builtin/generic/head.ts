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

import { IOResult } from '../../../io/types.ts'
import { Precision, ProvisionResult } from '../../../provision/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { headStream } from '../head_helper.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()

type Stat = (p: PathSpec) => Promise<FileStat>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

async function* headMulti(
  stream: Stream,
  paths: readonly PathSpec[],
  lines: number,
  bytesMode: number | null,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]
    if (p === undefined) continue
    if (paths.length > 1) {
      const prefix = i > 0 ? '\n' : ''
      yield ENC.encode(`${prefix}==> ${p.original} <==\n`)
    }
    const source = stream(p)
    for await (const chunk of headStream(source, lines, bytesMode)) yield chunk
  }
}

export async function headProvisionGeneric(
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
  stat: Stat,
): Promise<ProvisionResult> {
  const [first] = paths
  if (first === undefined) return new ProvisionResult({ command: 'head' })
  try {
    const s = await stat(first)
    const fileSize = s.size ?? 0
    const nFlag = typeof opts.flags.n === 'string' ? Number.parseInt(opts.flags.n, 10) : null
    const lines = nFlag !== null && Number.isFinite(nFlag) ? nFlag : 10
    const avgLine = 80
    const low = Math.min(lines * avgLine, fileSize)
    return new ProvisionResult({
      command: `head ${first.original}`,
      networkReadLow: low,
      networkReadHigh: fileSize,
      readOps: 1,
      precision: Precision.RANGE,
    })
  } catch {
    return new ProvisionResult({ command: 'head' })
  }
}

export async function headGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  stream: Stream,
): Promise<CommandFnResult> {
  const nRaw = typeof opts.flags.n === 'string' ? opts.flags.n : null
  const cRaw = typeof opts.flags.c === 'string' ? opts.flags.c : null
  const lineCount = nRaw !== null ? Number.parseInt(nRaw, 10) : 10
  const byteCount = cRaw !== null ? Number.parseInt(cRaw, 10) : null
  if (paths.length > 0) {
    for (const p of paths) await stat(p)
    return [headMulti(stream, paths, lineCount, byteCount), new IOResult()]
  }
  try {
    const source = resolveSource(opts.stdin, 'head: missing operand')
    return [headStream(source, lineCount, byteCount), new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}
