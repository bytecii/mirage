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

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { GDOCS_COMMANDS } from '../../commands/builtin/gdocs/index.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { read as gdocsRead } from '../../core/gdocs/read.ts'
import { readdir as gdocsReaddir } from '../../core/gdocs/readdir.ts'
import { stat as gdocsStat } from '../../core/gdocs/stat.ts'
import { TokenManager } from '../../core/google/client.ts'
import { GDOCS_OPS } from '../../ops/gdocs/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../base.ts'
import type { VFS } from '../base.ts'
import { GDOCS_PROMPT, GDOCS_WRITE_PROMPT } from './prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { redactGDocsConfig, type GDocsConfig, type GDocsConfigRedacted } from './config.ts'

const gdocsResolveGlob = makeResolveGlob(gdocsReaddir)

export interface GDocsVFSState {
  type: string
  config: GDocsConfigRedacted
}

export class GDocsVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GDOCS
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GDOCS_PROMPT
  readonly writePrompt: string = GDOCS_WRITE_PROMPT
  readonly config: GDocsConfig
  readonly accessor: GDocsAccessor

  constructor(config: GDocsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDocsAccessor({ tokenManager: tm })
  }

  commands(): readonly RegisteredCommand[] {
    return GDOCS_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GDOCS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gdocsRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gdocsReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gdocsStat(this.accessor, p, this.index)
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
    return gdocsResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GDocsVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGDocsConfig(this.config),
    })
  }
}
