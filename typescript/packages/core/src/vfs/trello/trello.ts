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

import { TrelloAccessor } from '../../accessor/trello.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { TRELLO_COMMANDS } from '../../commands/builtin/trello/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { HttpTrelloTransport } from '../../core/trello/client.ts'
import { read as trelloRead } from '../../core/trello/read.ts'
import { readdir as trelloReaddir } from '../../core/trello/readdir.ts'
import { stat as trelloStat } from '../../core/trello/stat.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { TRELLO_OPS } from '../../ops/trello/index.ts'
import { BaseVFS } from '../base.ts'
import type { VFS } from '../base.ts'
import { TRELLO_PROMPT, TRELLO_WRITE_PROMPT } from './prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { redactTrelloConfig, type TrelloConfig, type TrelloConfigRedacted } from './config.ts'

const resolveTrelloGlob = makeResolveGlob(trelloReaddir)

export interface TrelloVFSState {
  type: string
  config: TrelloConfigRedacted
}

export class TrelloVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.TRELLO
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = TRELLO_PROMPT
  readonly writePrompt: string = TRELLO_WRITE_PROMPT
  readonly config: TrelloConfig
  readonly accessor: TrelloAccessor

  constructor(config: TrelloConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; apiToken: string; baseUrl?: string } = {
      apiKey: config.apiKey,
      apiToken: config.apiToken,
    }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: { workspaceId?: string; boardIds?: readonly string[] } = {}
    if (config.workspaceId !== undefined) accessorOpts.workspaceId = config.workspaceId
    if (config.boardIds !== undefined) accessorOpts.boardIds = config.boardIds
    this.accessor = new TrelloAccessor(new HttpTrelloTransport(transportOpts), accessorOpts)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return TRELLO_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return TRELLO_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return trelloRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return trelloReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return trelloStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.vfsPath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  vfsPath: mountKey(p.virtual, prefix),
                }),
          )
        : paths
    return resolveTrelloGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<TrelloVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactTrelloConfig(this.config),
    })
  }

  override loadState(_state: TrelloVFSState): Promise<void> {
    return Promise.resolve()
  }
}
