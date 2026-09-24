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

import { BoundVFS } from '../bound.ts'
import { BOX_IO } from '../../commands/builtin/box/io.ts'
import { BoxAccessor } from '../../accessor/box.ts'
import { BOX_COMMANDS } from '../../commands/builtin/box/index.ts'

import type { RegisteredCommand } from '../../commands/config.ts'
import { BoxTokenManager } from '../../core/box/client.ts'

import { BOX_OPS } from '../../ops/box/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import type { VFS } from '../base.ts'
import { BOX_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactBoxConfig, type BoxConfig, type BoxConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/box/watch.ts'
import { type DeltaHook } from '../../watch/index.ts'

export interface BoxVFSState {
  type: string
  config: BoxConfigRedacted
}

export class BoxVFS extends BoundVFS<BoxAccessor> implements VFS {
  readonly kind: string = VFSName.BOX
  readonly cachesReads: boolean = true
  // Box item listings carry an exact byte `size` for every file (0
  // included); sizeless weblinks are filtered out of listings.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = BOX_PROMPT
  readonly config: BoxConfig
  readonly accessor: BoxAccessor

  constructor(config: BoxConfig) {
    super(BOX_IO)
    this.config = config
    // The whole config goes to the token manager, never a hand-picked
    // subset: a field added to BoxConfig would silently stop reaching it
    // (that is how gdrive lost apiBase and kept refreshing at the real
    // Google endpoint against a fake server).
    const tm = new BoxTokenManager(config)
    this.accessor = new BoxAccessor({
      tokenManager: tm,
      ...(config.rootFolderId !== undefined ? { rootFolderId: config.rootFolderId } : {}),
      ...(config.contentSearch !== undefined ? { contentSearch: config.contentSearch } : {}),
    })
  }

  commands(): readonly RegisteredCommand[] {
    return BOX_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return BOX_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<BoxVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactBoxConfig(this.config),
    })
  }
}
