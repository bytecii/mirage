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

import { LinearAccessor } from '../../accessor/linear.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { LINEAR_COMMANDS } from '../../commands/builtin/linear/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { HttpLinearTransport } from '../../core/linear/client.ts'
import { redactLinearConfig } from '../../core/linear/config.ts'
import type { LinearConfig, LinearConfigRedacted } from '../../core/linear/config.ts'
import { read as linearRead } from '../../core/linear/read.ts'
import { readdir as linearReaddir } from '../../core/linear/readdir.ts'
import { stat as linearStat } from '../../core/linear/stat.ts'
import { LINEAR_OPS } from '../../ops/linear/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../base.ts'
import type { VFS } from '../base.ts'
import { LINEAR_PROMPT, LINEAR_WRITE_PROMPT } from './prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'

const resolveLinearGlob = makeResolveGlob(linearReaddir)

export interface LinearVFSState {
  type: string
  config: LinearConfigRedacted
}

export class LinearVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.LINEAR
  readonly cachesReads: boolean = true
  // Every file is sized at its parent's readdir from the listing payload
  // (comments.jsonl via one bounded comments call), so stat always reports
  // the rendered byte length and fskit mounts serve exact reads.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = LINEAR_PROMPT
  readonly writePrompt: string = LINEAR_WRITE_PROMPT
  readonly config: LinearConfig
  readonly accessor: LinearAccessor

  constructor(config: LinearConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string } = { apiKey: config.apiKey }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: { teamIds?: readonly string[] } = {}
    if (config.teamIds !== undefined) accessorOpts.teamIds = config.teamIds
    this.accessor = new LinearAccessor(new HttpLinearTransport(transportOpts), accessorOpts)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return LINEAR_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return LINEAR_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return linearRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return linearReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return linearStat(this.accessor, p, this.index)
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
    return resolveLinearGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<LinearVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactLinearConfig(this.config),
    })
  }

  override loadState(_state: LinearVFSState): Promise<void> {
    return Promise.resolve()
  }
}
