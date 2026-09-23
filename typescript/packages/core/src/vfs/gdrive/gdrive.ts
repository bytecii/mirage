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

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { GDRIVE_COMMANDS } from '../../commands/builtin/gdrive/index.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { read as gdriveRead } from '../../core/gdrive/read.ts'
import { readdir as gdriveReaddir } from '../../core/gdrive/readdir.ts'
import { stat as gdriveStat } from '../../core/gdrive/stat.ts'
import { TokenManager } from '../../core/google/client.ts'
import { GDRIVE_OPS } from '../../ops/gdrive/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../base.ts'
import type { VFS } from '../base.ts'
import { GDRIVE_PROMPT } from './prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { redactGDriveConfig, type GDriveConfig, type GDriveConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/gdrive/watch.ts'
import { type DeltaHook } from '../../watch/index.ts'

const gdriveResolveGlob = makeResolveGlob(gdriveReaddir)

export interface GDriveVFSState {
  type: string
  config: GDriveConfigRedacted
}

export class GDriveVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GDRIVE
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GDRIVE_PROMPT
  readonly config: GDriveConfig
  readonly accessor: GDriveAccessor

  constructor(config: GDriveConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDriveAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GDRIVE_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GDRIVE_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gdriveRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gdriveReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gdriveStat(this.accessor, p, this.index)
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
    return gdriveResolveGlob(this.accessor, effective, this.index)
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<GDriveVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGDriveConfig(this.config),
    })
  }

  override loadState(_state: GDriveVFSState): Promise<void> {
    return Promise.resolve()
  }
}
