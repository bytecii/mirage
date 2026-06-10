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

import type { TrelloAccessor } from '../../../accessor/trello.ts'
import { resolveTrelloGlob } from '../../../core/trello/glob.ts'
import { readdir as trelloReaddir } from '../../../core/trello/readdir.ts'
import { stat as trelloStat } from '../../../core/trello/stat.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { treeGeneric } from '../generic/tree.ts'

async function treeCommand(
  accessor: TrelloAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved = await resolveTrelloGlob(accessor, paths, opts.index ?? undefined)
  return treeGeneric(
    resolved,
    opts,
    (p) => trelloReaddir(accessor, p, opts.index ?? undefined),
    (p) => trelloStat(accessor, p, opts.index ?? undefined),
  )
}

export const TRELLO_TREE = command({
  name: 'tree',
  resource: ResourceName.TRELLO,
  spec: specOf('tree'),
  fn: treeCommand,
})
