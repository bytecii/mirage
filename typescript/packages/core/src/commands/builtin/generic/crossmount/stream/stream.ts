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

import { asyncChain } from '../../../../../io/stream.ts'
import { readFailExitCodeFromLine } from '../../../../spec/usage.ts'
import { IOResult, materialize, type ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import {
  fetchRefusal,
  flagRefusal,
  operandRefusal,
  parseFlags as parseSortFlags,
  type SortFlags,
} from '../../sort.ts'
import { Cmd, type CrossResult, type RunSingle } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function hasActiveFlags(flagKwargs: Record<string, FlagValue>): boolean {
  return Object.values(flagKwargs).some((v) => v !== false)
}

// The per-operand fetch is a native Cmd.CAT sub-run, so its error lines
// carry the fetch command's prefix; respell them to the real command so the
// cross-mount bytes match single-mount.
function respellFetchStderr(stderr: Uint8Array, cmdName: string): Uint8Array {
  const fetchPrefix = `${Cmd.CAT}: `
  const lines = DEC.decode(stderr).split('\n')
  const respelled = lines.map((line) =>
    line.startsWith(fetchPrefix) ? `${cmdName}: ${line.slice(fetchPrefix.length)}` : line,
  )
  return ENC.encode(respelled.join('\n'))
}

// A failed fetch's lines without the fetch command's prefix, which is what
// sort's own refusal is built from.
function fetchFailures(stderr: Uint8Array): string[] {
  const fetchPrefix = `${Cmd.CAT}: `
  return DEC.decode(stderr)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (line.startsWith(fetchPrefix) ? line.slice(fetchPrefix.length) : line))
}

// sort ends every input's last line, where cat would run it into the next
// input's first.
async function terminated(source: ByteSource, separator: number): Promise<Uint8Array> {
  const data = await materialize(source)
  if (data.byteLength === 0 || data[data.byteLength - 1] === separator) return data
  const out = new Uint8Array(data.byteLength + 1)
  out.set(data)
  out[data.byteLength] = separator
  return out
}

// Run a stream command (`cmd files...` == `cat files... | cmd`). Each
// operand's raw bytes come from a native flagless `cat` on its owning mount
// (which also expands the operand's glob natively); one native run of the
// real command then consumes the merged stream in its stdin mode, so every
// flag keeps its single-invocation semantics (continuous `cat -n`/`nl`
// numbering, one global `sort` order, one `sed` address space). A failed
// operand is skipped and reported on stderr, cat-style; the merged exit code
// is then non-zero.
//
// `sort` is the one stream command whose operands are not simply
// concatenated, so it answers in the single-mount generic's words: the
// line's own refusals before any fetch, one refusal for failed inputs ranked
// the generic's way, and every input's last line ended. Its `-m` is dropped
// from the run over the merged stream, which a merge would only echo back;
// sorting that stream is the merge whenever each input is sorted, which is
// what `-m` promises. Deliberate divergence: unsorted inputs to a
// cross-mount `sort -m` come out sorted, where GNU emits them merged but
// unsorted.
export async function runStream(
  cmdName: Cmd,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  runSingle: RunSingle,
): Promise<CrossResult> {
  let sortFlags: SortFlags | null = null
  if (cmdName === Cmd.SORT) {
    let refusal = flagRefusal(flagKwargs)
    if (refusal === null) {
      sortFlags = parseSortFlags(flagKwargs)
      refusal = operandRefusal(scopes, sortFlags)
    }
    if (refusal !== null) return [null, refusal]
  }
  let mergedIo = new IOResult()
  const sources: ByteSource[] = []
  const sortFailures: string[] = []
  let failed = false
  // The real command's code for the worst failed fetch. The fetch runs as
  // Cmd.CAT, so its own code is cat's 1 whatever went wrong; the stderr is
  // already respelled into the real command's voice and the code has to
  // follow it, or `sort a /other/missing` answers 1 while `sort missing`
  // answers 2.
  let failCode = 0
  for (const scope of scopes) {
    const [out, io] = await runSingle(Cmd.CAT, [scope], [], {})
    if (io.exitCode !== 0) {
      failed = true
      if (io.stderr !== null) {
        let rendered = await materialize(io.stderr)
        if (sortFlags !== null) {
          sortFailures.push(...fetchFailures(rendered))
          io.stderr = null
        } else if (cmdName !== Cmd.CAT) {
          rendered = respellFetchStderr(rendered, cmdName)
          io.stderr = rendered
        }
        failCode = Math.max(failCode, readFailExitCodeFromLine(cmdName, DEC.decode(rendered)))
      }
      // The fetch ran as cat, so its exit code is cat's whatever went
      // wrong. failCode already carries the real command's, and merging
      // cat's over it would win the `||` below.
      io.exitCode = 0
      mergedIo = await mergedIo.merge(io)
      continue
    }
    mergedIo = await mergedIo.merge(io)
    if (out !== null && sortFlags !== null) {
      sources.push(await terminated(out, sortFlags.zeroTerminated ? 0 : 10))
    } else if (out !== null) {
      sources.push(out)
    }
  }
  // sort aborts on any failed operand like GNU (it needs every input
  // before emitting anything), matching the single-mount builder.
  if (failed && sortFlags !== null) {
    mergedIo.stderr = fetchRefusal(sortFailures, sortFlags)
    mergedIo.exitCode = mergedIo.exitCode || failCode || 1
    return [null, mergedIo]
  }

  const body: ByteSource = asyncChain(...sources)

  if (cmdName === Cmd.CAT && !hasActiveFlags(flagKwargs)) {
    if (failed) mergedIo.exitCode = mergedIo.exitCode || failCode || 1
    return [body, mergedIo]
  }

  let tailFlags = flagKwargs
  if (sortFlags?.merge === true) {
    tailFlags = Object.fromEntries(Object.entries(flagKwargs).filter(([key]) => key !== 'merge'))
  }
  const [out, io] = await runSingle(cmdName, [], [...textArgs], tailFlags, {
    stdin: body,
    resolveHint: scopes[0] ?? null,
  })
  mergedIo = await mergedIo.merge(io)
  if (failed) mergedIo.exitCode = mergedIo.exitCode || failCode || 1
  return [out, mergedIo]
}
