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
import { grepBytes } from '../../../core/chroma/grep.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()

async function grepCommand(
  accessor: ChromaAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const index = opts.index ?? undefined
  const resolved = paths.length > 0 ? await resolveGlob(accessor, paths, index) : []
  let pattern: string
  if (typeof opts.flags.e === 'string') {
    pattern = opts.flags.e
  } else if (texts.length > 0 && texts[0] !== undefined) {
    pattern = texts[0]
  } else {
    return [
      null,
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode('grep: usage: grep [flags] pattern [path]\n'),
      }),
    ]
  }
  const [output, reads] = await grepBytes(accessor, resolved, pattern, index, {
    ignoreCase: opts.flags.i === true,
    invert: opts.flags.v === true,
    lineNumbers: opts.flags.n === true,
    countOnly: opts.flags.c === true,
    filesOnly: opts.flags.args_l === true || opts.flags.l === true,
    wholeWord: opts.flags.w === true,
    fixedString: opts.flags.F === true,
    onlyMatching: opts.flags.o === true,
    maxCount: typeof opts.flags.m === 'string' ? Number.parseInt(opts.flags.m, 10) : null,
  })
  const io = new IOResult({
    reads,
    cache: Object.keys(reads),
    exitCode: output.byteLength > 0 ? 0 : 1,
  })
  if (opts.flags.q === true) {
    return [new Uint8Array(0), io]
  }
  return [output, io]
}

export const CHROMA_GREP = command({
  name: 'grep',
  resource: ResourceName.CHROMA,
  spec: specOf('grep'),
  fn: grepCommand,
})
