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
import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gunzipChecked } from '../../../utils/compress.ts'
import { GzipDataError } from '../../../utils/errors.ts'
import type { CommandFnResult, CommandOpts, WritesFn } from '../../config.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { operandLabel, stdinStream } from '../utils/stream.ts'

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

// Whether a gunzip invocation writes: each file operand is replaced by its
// content unless -c sends it to stdout or -t only tests it, while a `-`
// operand, like no operand, filters stdin to stdout. Mirrors Python's
// gunzip_writes.
export const gunzipWrites: WritesFn = (flags, paths) => {
  const fl = new FlagView(flags, specOf('gunzip'))
  const replaces = paths.some((p) => p.rawPath !== '-')
  return replaces && !(fl.asBool('c') || fl.asBool('t'))
}

export async function gunzipGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  unlink: (p: PathSpec) => Promise<void>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('gunzip'))
  const keep = fl.asBool('k')
  const stdoutMode = fl.asBool('c')
  const testMode = fl.asBool('t')
  const read = stdinStream(stream, opts.stdin)
  const writes: Record<string, Uint8Array> = {}
  const stdout: Uint8Array[] = []
  let errors = ''
  // With no operand gunzip reads stdin. A `-` has no file to replace, so it
  // decompresses to stdout; gzip refuses to follow /dev/stdin in place, so
  // only `-` does this. An input with no gzip header is reported and skipped;
  // a truncated or corrupt one ends the run.
  for (const p of paths.length > 0 ? paths : [STDIN_OPERAND]) {
    const inPlace = !(stdoutMode || testMode || p.rawPath === '-')
    const raw = await materialize(inPlace ? stream(p) : read(p))
    let data: Uint8Array
    try {
      data = await gunzipChecked(raw)
    } catch (err) {
      if (!(err instanceof GzipDataError)) throw err
      errors += `gunzip: ${operandLabel(p, 'stdin')}: ${err.message}\n`
      if (err.fatal) break
      continue
    }
    if (testMode) continue
    if (!inPlace) {
      stdout.push(data)
      continue
    }
    const pStripped = p.mountPath
    const outPath = pStripped.endsWith('.gz') ? pStripped.slice(0, -3) : pStripped + '.out'
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
