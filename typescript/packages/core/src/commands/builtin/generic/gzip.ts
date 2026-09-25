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
import { FlagView } from '../../spec/flag_view.ts'
import { mountedPath } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gunzipChecked, gzip } from '../../../utils/compress.ts'
import { GzipDataError } from '../../../utils/errors.ts'
import type { CommandFnResult, CommandOpts, WritesFn } from '../../config.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { operandLabel, resolveSource, stdinStream } from '../utils/stream.ts'

const ENC = new TextEncoder()

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

// Whether a gzip invocation writes: each file operand is replaced by its
// archive unless -c sends the result to stdout, while a `-` operand, like no
// operand, filters stdin to stdout. Mirrors Python's gzip_writes.
export const gzipWrites: WritesFn = (flags, paths) =>
  paths.some((p) => p.rawPath !== '-') && !new FlagView(flags, specOf('gzip')).asBool('c')

export async function gzipGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  unlink: (p: PathSpec) => Promise<void>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('gzip'))
  const decompress = fl.asBool('d')
  const keep = fl.asBool('k')
  const stdoutMode = fl.asBool('c')

  if (paths.length === 0 && !decompress) {
    const result: ByteSource = await gzip(await materialize(resolveSource(opts.stdin)))
    return [result, new IOResult()]
  }
  const read = stdinStream(stream, opts.stdin)
  const writes: Record<string, Uint8Array> = {}
  const stdout: Uint8Array[] = []
  let errors = ''
  // With no operand gzip -d reads stdin. A `-` has no file to replace, so it
  // goes to stdout; gzip refuses to follow /dev/stdin in place, so only `-`
  // does this. An input with no gzip header is reported and skipped; a
  // truncated or corrupt one ends the run.
  for (const p of paths.length > 0 ? paths : [STDIN_OPERAND]) {
    const inPlace = !(stdoutMode || p.rawPath === '-')
    const raw = await materialize(inPlace ? stream(p) : read(p))
    let data: Uint8Array
    if (decompress) {
      try {
        data = await gunzipChecked(raw)
      } catch (err) {
        if (!(err instanceof GzipDataError)) throw err
        errors += `gzip: ${operandLabel(p, 'stdin')}: ${err.message}\n`
        if (err.fatal) break
        continue
      }
    } else {
      data = await gzip(raw)
    }
    if (!inPlace) {
      stdout.push(data)
      continue
    }
    const pStripped = p.mountPath
    let outPath: string
    if (decompress) {
      outPath = pStripped.endsWith('.gz') ? pStripped.slice(0, -3) : pStripped + '.out'
    } else {
      outPath = pStripped + '.gz'
    }
    await write(mountedPath(p, outPath), data)
    writes[outPath] = data
    if (!keep) await unlink(p)
  }
  return [
    stdout.length > 0 ? concat(stdout) : null,
    new IOResult({
      writes,
      exitCode: errors === '' ? 0 : 1,
      stderr: errors === '' ? null : ENC.encode(errors),
    }),
  ]
}
