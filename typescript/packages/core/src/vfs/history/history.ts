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
import { HISTORY_IO } from '../../commands/builtin/history/io.ts'
import { HistoryAccessor } from '../../accessor/history.ts'

import type { FindOptions } from '../../core/ram/find.ts'

import { HISTORY_COMMANDS } from '../../commands/builtin/history/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import type { Observer } from '../../observe/observer.ts'
import { HISTORY_OPS } from '../../ops/history/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import { type PathSpec, VFSName } from '../../types.ts'
import { type VFS } from '../base.ts'

export const HISTORY_PREFIX = '/.bash_history'

/**
 * Read-only view VFS backing the /.bash_history mount. Renders GNU
 * views from the workspace's hidden recorder on every read; holds no
 * storage of its own.
 */

export class HistoryViewVFS extends BoundVFS<HistoryAccessor> implements VFS {
  declare find: (path: PathSpec, options?: FindOptions) => Promise<string[]>

  readonly kind = VFSName.HISTORY
  readonly cachesReads = false
  // The view renders from in-memory events, so stat() sizes it by
  // rendering: cheap, no network, and never null.
  readonly sizesAlwaysKnown = true
  readonly accessor: HistoryAccessor

  constructor(observer: Observer) {
    super(HISTORY_IO)
    this.accessor = new HistoryAccessor(observer)
  }

  ops(): readonly RegisteredOp[] {
    return HISTORY_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return HISTORY_COMMANDS
  }
}
