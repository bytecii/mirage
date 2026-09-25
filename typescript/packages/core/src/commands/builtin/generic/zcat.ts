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

import type { ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gunzipChecked } from '../../../utils/compress.ts'
import { GzipDataError } from '../../../utils/errors.ts'
import { concat } from '../../../io/cachable_iterator.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { operandLabel, readStdinAsync, stdinStream } from '../utils/stream.ts'
import { operandsIo, readOperandsCoded, type ReadOperand } from '../utils/operands.ts'

export async function zcatGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  // Each operand decompresses independently and the outputs concatenate in
  // operand order, like GNU zcat. A missing operand is reported and skipped.
  // zcat is gzip's front end, so its exit code is gzip's: a directory is a
  // warning (2) and a missing file is an error (1), which no other member of
  // this family distinguishes. Hence the coded read.
  let ok: ReadOperand[]
  let err = ''
  let code = 0
  if (paths.length > 0) {
    ;[ok, err, code] = await readOperandsCoded(paths, stream, 'zcat')
  } else {
    const data = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
    ok = [{ path: STDIN_OPERAND, data }]
  }
  // An input with no gzip header is reported and skipped; a truncated or
  // corrupt one ends the run. A bad archive is gzip's error (1), which
  // outranks a directory's warning (2).
  const parts: Uint8Array[] = []
  let bad = ''
  for (const o of ok) {
    try {
      parts.push(await gunzipChecked(o.data))
    } catch (e) {
      if (!(e instanceof GzipDataError)) throw e
      bad += `zcat: ${operandLabel(o.path, 'stdin')}: ${e.message}\n`
      if (e.fatal) break
    }
  }
  const io = operandsIo(bad + err, { exitCode: bad === '' ? code : 1 })
  const result: ByteSource = concat(parts)
  return [result, io]
}
