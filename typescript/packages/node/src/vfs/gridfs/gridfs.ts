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

import { BoundVFS } from '@struktoai/mirage-core/vfs/bound'
import { GRIDFS_IO } from '../../commands/builtin/gridfs/io.ts'

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import type { FindOptions, VFS } from '@struktoai/mirage-core/vfs/base'
import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { VFSName } from '@struktoai/mirage-core/types'

import { GridFSAccessor } from '../../accessor/gridfs.ts'
import { GRIDFS_COMMANDS } from '../../commands/builtin/gridfs/index.ts'

import { GRIDFS_OPS } from '../../ops/gridfs/index.ts'
import { redactConfig, type GridFSConfig, type GridFSConfigRedacted } from './config.ts'
import { GRIDFS_PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/gridfs/watch.ts'

export interface GridFSVFSState {
  type: string
  config: GridFSConfigRedacted
}

export class GridFSVFS extends BoundVFS<GridFSAccessor> implements VFS {
  declare appendFile: (path: PathSpec, data: Uint8Array) => Promise<void>

  declare writeFile: (p: PathSpec, data: Uint8Array) => Promise<void>

  declare exists: (p: PathSpec) => Promise<boolean>

  declare mkdir: (p: PathSpec) => Promise<void>

  declare rmdir: (p: PathSpec) => Promise<void>

  declare unlink: (p: PathSpec) => Promise<void>

  declare rename: (src: PathSpec, dst: PathSpec) => Promise<void>

  declare truncate: (p: PathSpec, length: number) => Promise<void>

  declare copy: (src: PathSpec, dst: PathSpec) => Promise<void>

  declare rmR: (p: PathSpec) => Promise<void>

  declare du: (p: PathSpec) => Promise<number>

  declare find: (p: PathSpec, options?: FindOptions) => Promise<string[]>

  readonly kind: string = VFSName.GRIDFS
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = true
  // byte store: stat() sizes every file from metadata
  readonly sizesAlwaysKnown: boolean = true
  // stat and read both stamp str(file_id), so the gate compares like
  // with like.
  readonly readRevalidatable: boolean = true
  readonly prompt: string = GRIDFS_PROMPT
  readonly config: GridFSConfig
  readonly accessor: GridFSAccessor

  constructor(config: GridFSConfig) {
    super(GRIDFS_IO)
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: GridFSConfig = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    this.accessor = new GridFSAccessor(this.config)
  }

  override async close(): Promise<void> {
    await this.accessor.close()
    await super.close()
  }

  commands(): readonly RegisteredCommand[] {
    return GRIDFS_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GRIDFS_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<GridFSVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactConfig(this.config),
    })
  }
}
