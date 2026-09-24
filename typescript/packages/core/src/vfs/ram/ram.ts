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
import { RAM_IO } from '../../commands/builtin/ram/io.ts'

import { RAM_COMMANDS } from '../../commands/builtin/ram/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'

import { RAMAccessor } from '../../accessor/ram.ts'
import { RAM_OPS } from '../../ops/ram/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import type { PathSpec } from '../../types.ts'
import { VFSName } from '../../types.ts'
import { type FindOptions, type VFS } from '../base.ts'
import { RAM_PROMPT } from './prompt.ts'
import { RAMStore, type RAMAttrs } from './store.ts'

export interface RAMVFSState {
  type: string
  files?: Record<string, Uint8Array>
  dirs?: string[]
  modified?: Record<string, string>
  attrs?: Record<string, RAMAttrs>
}

export class RAMVFS extends BoundVFS<RAMAccessor> implements VFS {
  declare writeFile: (path: PathSpec, data: Uint8Array) => Promise<void>

  declare appendFile: (path: PathSpec, data: Uint8Array) => Promise<void>

  declare exists: (path: PathSpec) => Promise<boolean>

  declare mkdir: (path: PathSpec, options?: { recursive?: boolean }) => Promise<void>

  declare rmdir: (path: PathSpec) => Promise<void>

  declare unlink: (path: PathSpec) => Promise<void>

  declare rename: (src: PathSpec, dst: PathSpec) => Promise<void>

  declare truncate: (path: PathSpec, length: number) => Promise<void>

  declare copy: (src: PathSpec, dst: PathSpec) => Promise<void>

  declare rmR: (path: PathSpec) => Promise<void>

  declare du: (path: PathSpec) => Promise<number>

  declare find: (path: PathSpec, options?: FindOptions) => Promise<string[]>

  constructor(io: typeof RAM_IO = RAM_IO) {
    super(io)
  }

  readonly kind = VFSName.RAM
  readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 0
  readonly store = new RAMStore()
  readonly accessor = new RAMAccessor(this.store)
  readonly prompt = RAM_PROMPT

  ops(): readonly RegisteredOp[] {
    return RAM_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return RAM_COMMANDS
  }

  override getState(): RAMVFSState {
    const files: Record<string, Uint8Array> = {}
    for (const [k, v] of this.store.files) files[k] = v
    const modified: Record<string, string> = {}
    for (const [k, v] of this.store.modified) modified[k] = v
    const attrs: Record<string, RAMAttrs> = {}
    for (const [k, v] of this.store.attrs) attrs[k] = { ...v }
    return {
      type: this.kind,
      files,
      dirs: [...this.store.dirs],
      modified,
      attrs,
    }
  }

  override loadState(state: RAMVFSState): void {
    this.store.files.clear()
    for (const [k, v] of Object.entries(state.files ?? {})) this.store.files.set(k, v)
    this.store.dirs.clear()
    const dirs = state.dirs ?? []
    for (const d of dirs.length > 0 ? dirs : ['/']) this.store.dirs.add(d)
    this.store.modified.clear()
    for (const [k, v] of Object.entries(state.modified ?? {})) this.store.modified.set(k, v)
    this.store.attrs.clear()
    for (const [k, v] of Object.entries(state.attrs ?? {})) this.store.attrs.set(k, { ...v })
  }
}
