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

import type { ChromaAccessor } from '../../../accessor/chroma.ts'
import { resolveGlob } from '../../../core/chroma/glob.ts'
import { readBytes, readStream } from '../../../core/chroma/read.ts'
import { CachableAsyncIterator } from '../../../io/cachable_iterator.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function numberLines(data: Uint8Array): Uint8Array {
  const text = DEC.decode(data)
  const lines = text.split('\n')
  const trailing = text.endsWith('\n')
  const limit = trailing ? lines.length - 1 : lines.length
  const out: string[] = []
  for (let i = 0; i < limit; i++) {
    out.push(`     ${String(i + 1)}\t${lines[i] ?? ''}\n`)
  }
  return ENC.encode(out.join(''))
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

async function catCommand(
  accessor: ChromaAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const index = opts.index ?? undefined
  const resolved = await resolveGlob(accessor, paths, index)
  const nFlag = opts.flags.n === true
  const first = resolved[0]
  let source: ByteSource
  let io: IOResult
  if (resolved.length === 1 && first !== undefined) {
    const cachable = new CachableAsyncIterator(readStream(accessor, first, index))
    io = new IOResult({ reads: { [first.original]: cachable }, cache: [first.original] })
    source = cachable
  } else {
    const reads: Record<string, ByteSource> = {}
    const parts: Uint8Array[] = []
    for (const p of resolved) {
      const data = await readBytes(accessor, p, index)
      reads[p.original] = data
      parts.push(data)
    }
    io = new IOResult({ reads, cache: Object.keys(reads) })
    source = concat(parts)
  }
  if (nFlag) {
    return [numberLines(await materialize(source)), io]
  }
  return [source, io]
}

export const CHROMA_CAT = command({
  name: 'cat',
  resource: ResourceName.CHROMA,
  spec: specOf('cat'),
  fn: catCommand,
})
