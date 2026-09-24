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

import { BinAccessor } from '../../accessor/bin.ts'
import { BIN_COMMANDS } from '../../commands/builtin/bin/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { read as readCore } from '../../core/bin/read.ts'
import { readdir as readdirCore } from '../../core/bin/readdir.ts'
import { stat as statCore } from '../../core/bin/stat.ts'
import { BIN_OPS } from '../../ops/bin/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import type { FileStat } from '../../types.ts'
import { type PathSpec, VFSName } from '../../types.ts'
import { BaseVFS, type VFS } from '../base.ts'

/**
 * Read-only view VFS backing the /usr/bin mount. Lists one executable
 * file per program the session can run, rendered from the workspace's
 * command lookup on every call; holds no storage of its own.
 */
export class BinViewVFS extends BaseVFS implements VFS {
  readonly kind = VFSName.BIN
  readonly cachesReads = false
  // A stub's size is its rendering: cheap, no network, never null.
  readonly sizesAlwaysKnown = true
  readonly accessor: BinAccessor

  constructor(programs: () => string[], note: (name: string) => string | null) {
    super()
    this.accessor = new BinAccessor(programs, note)
  }

  override open(): Promise<void> {
    return Promise.resolve()
  }

  ops(): readonly RegisteredOp[] {
    return BIN_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return BIN_COMMANDS
  }

  readFile(path: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, path)
  }

  readdir(path: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, path)
  }

  stat(path: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, path)
  }
}
