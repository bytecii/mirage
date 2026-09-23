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

import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { RAMAccessor } from '../../accessor/ram.ts'
import { DEV_COMMANDS } from '../../commands/builtin/dev/index.ts'
import { read, stat, stream } from '../../core/dev/index.ts'
import { DEV_OPS } from '../../ops/dev/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { type FileStat, type PathSpec } from '../../types.ts'
import { RAMVFS } from '../ram/ram.ts'
import type { RAMStore } from '../ram/store.ts'
import { type DevFiles, DevStore } from './store.ts'

class DevIndex extends RAMIndexCacheStore {
  override seed(): void {
    return undefined
  }
  override put(): Promise<void> {
    return Promise.resolve()
  }
  override setDir(): Promise<void> {
    return Promise.resolve()
  }
}

export class DevVFS extends RAMVFS {
  override readonly store: RAMStore = new DevStore() as unknown as RAMStore
  override readonly accessor: RAMAccessor = new RAMAccessor(this.store)

  constructor() {
    super()
    this.opsMap.read_bytes = read
    this.opsMap.read_stream = stream
    this.opsMap.stat = stat
  }

  private readonly descriptorIndex = new DevIndex()

  override get index(): IndexCacheStore {
    // A path-only index must not publish one session's descriptors to another.
    return this.descriptorIndex
  }

  allocateInput(): readonly [string, number] {
    return (this.store.files as DevFiles).allocateInput()
  }

  setInput(path: string, allocation: number, data: Uint8Array): void {
    const files = this.store.files as DevFiles
    files.setInput(path, allocation, data)
  }

  releaseInput(path: string, allocation: number): void {
    const files = this.store.files as DevFiles
    if (files.releaseInput(path, allocation)) {
      this.store.modified.delete(path.slice(4))
      this.store.attrs.delete(path.slice(4))
    }
  }

  override ops(): readonly RegisteredOp[] {
    return DEV_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return DEV_COMMANDS
  }

  override streamPath(path: PathSpec): AsyncIterable<Uint8Array> {
    return stream(this.accessor, path)
  }

  override readFile(path: PathSpec): Promise<Uint8Array> {
    return read(this.accessor, path)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return stat(this.accessor, path)
  }
}
