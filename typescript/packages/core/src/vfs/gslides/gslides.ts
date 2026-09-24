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

import { GSlidesAccessor } from '../../accessor/gslides.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { GSLIDES_COMMANDS } from '../../commands/builtin/gslides/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { TokenManager } from '../../core/google/client.ts'
import { read as gslidesRead } from '../../core/gslides/read.ts'
import { readdir as gslidesReaddir } from '../../core/gslides/readdir.ts'
import { stat as gslidesStat } from '../../core/gslides/stat.ts'
import { GSLIDES_OPS } from '../../ops/gslides/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../base.ts'
import type { VFS } from '../base.ts'
import { GSLIDES_PROMPT, GSLIDES_WRITE_PROMPT } from './prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { redactGSlidesConfig, type GSlidesConfig, type GSlidesConfigRedacted } from './config.ts'

const gslidesResolveGlob = makeResolveGlob(gslidesReaddir)

export interface GSlidesVFSState {
  type: string
  config: GSlidesConfigRedacted
}

export class GSlidesVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GSLIDES
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GSLIDES_PROMPT
  readonly writePrompt: string = GSLIDES_WRITE_PROMPT
  readonly config: GSlidesConfig
  readonly accessor: GSlidesAccessor

  constructor(config: GSlidesConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
  }

  commands(): readonly RegisteredCommand[] {
    return GSLIDES_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GSLIDES_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gslidesRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gslidesReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gslidesStat(this.accessor, p, this.index)
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
    return gslidesResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GSlidesVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGSlidesConfig(this.config),
    })
  }
}
