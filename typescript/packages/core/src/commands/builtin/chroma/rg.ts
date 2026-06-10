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
import { readStream } from '../../../core/chroma/read.ts'
import { readdir as chromaReaddir } from '../../../core/chroma/readdir.ts'
import { statLight } from '../../../core/chroma/stat.ts'
import { type FileStat, ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { rgGeneric } from '../generic/rg.ts'

async function rgCommand(
  accessor: ChromaAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => statLight(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    chromaReaddir(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, opts, stat, readdir, (p) =>
    readStream(accessor, p, opts.index ?? undefined),
  )
}

export const CHROMA_RG = command({
  name: 'rg',
  resource: ResourceName.CHROMA,
  spec: specOf('rg'),
  fn: rgCommand,
})
