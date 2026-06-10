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

import type { LinearAccessor } from '../../../accessor/linear.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { resolveLinearGlob } from '../../../core/linear/glob.ts'
import { read as linearRead } from '../../../core/linear/read.ts'
import { stat as linearStat } from '../../../core/linear/stat.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { catGeneric } from '../generic/cat.ts'
import { fileReadProvision } from './_provision.ts'

async function* linearStream(
  accessor: LinearAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await linearRead(accessor, p, index)
}

async function catCommand(
  accessor: LinearAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveLinearGlob(accessor, paths, opts.index ?? undefined) : []
  return catGeneric(
    resolved,
    texts,
    opts,
    (p) => linearStat(accessor, p, opts.index ?? undefined),
    (p) => linearStream(accessor, p, opts.index ?? undefined),
  )
}

export const LINEAR_CAT = command({
  name: 'cat',
  resource: ResourceName.LINEAR,
  spec: specOf('cat'),
  fn: catCommand,
  provision: fileReadProvision,
})
