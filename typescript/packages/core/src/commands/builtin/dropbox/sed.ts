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

import type { DropboxAccessor } from '../../../accessor/dropbox.ts'
import { resolveGlob } from '../../../core/dropbox/glob.ts'
import { stream as dropboxStream } from '../../../core/dropbox/read.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { sedGeneric } from '../generic/sed.ts'

const ENC = new TextEncoder()

async function sedCommand(
  accessor: DropboxAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (opts.flags.i === true) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('sed -i not supported on read-only Dropbox mount\n'),
      }),
    ]
  }
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    dropboxStream(accessor, p, opts.index ?? undefined)
  return sedGeneric(resolved, texts, opts, stream, () =>
    Promise.reject(new Error('sed: dropbox mount is read-only')),
  )
}

export const DROPBOX_SED = command({
  name: 'sed',
  resource: ResourceName.DROPBOX,
  spec: specOf('sed'),
  fn: sedCommand,
})
