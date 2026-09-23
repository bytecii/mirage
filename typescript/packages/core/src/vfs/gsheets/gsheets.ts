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

import { GSheetsAccessor } from '../../accessor/gsheets.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { GSHEETS_COMMANDS } from '../../commands/builtin/gsheets/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { TokenManager } from '../../core/google/client.ts'
import { read as gsheetsRead } from '../../core/gsheets/read.ts'
import { readdir as gsheetsReaddir } from '../../core/gsheets/readdir.ts'
import { stat as gsheetsStat } from '../../core/gsheets/stat.ts'
import { GSHEETS_OPS } from '../../ops/gsheets/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../base.ts'
import type { VFS } from '../base.ts'
import { GSHEETS_PROMPT, GSHEETS_WRITE_PROMPT } from './prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { redactGSheetsConfig, type GSheetsConfig, type GSheetsConfigRedacted } from './config.ts'

const gsheetsResolveGlob = makeResolveGlob(gsheetsReaddir)

export interface GSheetsVFSState {
  type: string
  config: GSheetsConfigRedacted
}

export class GSheetsVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GSHEETS
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GSHEETS_PROMPT
  readonly writePrompt: string = GSHEETS_WRITE_PROMPT
  readonly config: GSheetsConfig
  readonly accessor: GSheetsAccessor

  constructor(config: GSheetsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSheetsAccessor({ tokenManager: tm })
  }

  commands(): readonly RegisteredCommand[] {
    return GSHEETS_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GSHEETS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gsheetsRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gsheetsReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gsheetsStat(this.accessor, p, this.index)
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
    return gsheetsResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GSheetsVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGSheetsConfig(this.config),
    })
  }
}
