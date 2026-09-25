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
import { gzip, gunzip } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts, WritesFn } from '../../config.ts'
import { resolveSource, stdinStream } from '../utils/stream.ts'

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

  if (paths.length === 0) {
    let source: AsyncIterable<Uint8Array>
    try {
      source = decompress
        ? resolveSource(opts.stdin, 'gzip: (stdin): unexpected end of file')
        : resolveSource(opts.stdin)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
    }
    const data = await materialize(source)
    const out = decompress ? await gunzip(data) : await gzip(data)
    const result: ByteSource = out
    return [result, new IOResult()]
  }

  const read = stdinStream(stream, opts.stdin)
  if (stdoutMode) {
    const chunks: Uint8Array[] = []
    for (const p of paths) {
      const raw = await materialize(read(p))
      const out = decompress ? await gunzip(raw) : await gzip(raw)
      chunks.push(out)
    }
    return [concat(chunks), new IOResult()]
  }

  const writes: Record<string, Uint8Array> = {}
  // A `-` has no file to replace, so it goes to stdout; gzip refuses to
  // follow /dev/stdin in place, so only `-` does this.
  const stdout: Uint8Array[] = []
  for (const p of paths) {
    if (p.rawPath === '-') {
      const raw = await materialize(read(p))
      stdout.push(decompress ? await gunzip(raw) : await gzip(raw))
      continue
    }
    const raw = await materialize(stream(p))
    const pStripped = p.mountPath
    let outPath: string
    let outData: Uint8Array
    if (decompress) {
      outPath = pStripped.endsWith('.gz') ? pStripped.slice(0, -3) : pStripped + '.out'
      outData = await gunzip(raw)
    } else {
      outPath = pStripped + '.gz'
      outData = await gzip(raw)
    }
    await write(mountedPath(p, outPath), outData)
    writes[outPath] = outData
    if (!keep) await unlink(p)
  }
  return [stdout.length > 0 ? concat(stdout) : null, new IOResult({ writes })]
}
