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

import type { LangfuseAccessor } from '../../../accessor/langfuse.ts'
import { resolveLangfuseGlob } from '../../../core/langfuse/glob.ts'
import { readdir as langfuseReaddir } from '../../../core/langfuse/readdir.ts'
import { stat as langfuseStat } from '../../../core/langfuse/stat.ts'
import { PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { lsGeneric } from '../generic/ls.ts'
import { metadataProvision } from './_provision.ts'

async function lsCommand(
  accessor: LangfuseAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  let workingPaths: PathSpec[] = paths
  if (workingPaths.length === 0) {
    workingPaths = [
      new PathSpec({
        original: opts.cwd,
        directory: opts.cwd,
        resolved: false,
        prefix: opts.mountPrefix ?? '',
      }),
    ]
  }
  const resolved = await resolveLangfuseGlob(accessor, workingPaths, opts.index ?? undefined)
  return lsGeneric(
    resolved,
    opts,
    (p) => langfuseReaddir(accessor, p, opts.index ?? undefined),
    (p) => langfuseStat(accessor, p, opts.index ?? undefined),
  )
}

export const LANGFUSE_LS = command({
  name: 'ls',
  resource: ResourceName.LANGFUSE,
  spec: specOf('ls'),
  fn: lsCommand,
  provision: metadataProvision,
})
