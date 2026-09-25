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
import { DISK_IO } from '../../commands/builtin/disk/io.ts'
import {
  chmod,
  mkdir,
  readFile,
  stat as fsStat,
  statfs as fsStatfs,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import type { FindOptions, VFS } from '@struktoai/mirage-core/vfs/base'
import { CapacityState, PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { CapacityResult } from '@struktoai/mirage-core/types'

import { DISK_COMMANDS } from '../../commands/builtin/disk/index.ts'

import { readEntries, resolveInside } from '../../core/disk/utils.ts'
import { DiskAccessor } from '../../accessor/disk.ts'
import { DISK_OPS } from '../../ops/disk/index.ts'
import { DISK_PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/disk/watch/index.ts'

export interface DiskVFSOptions {
  root: string
}

export interface DiskVFSState {
  type: string
  files: Record<string, Uint8Array>
  modes?: Record<string, number>
}

async function walkFiles(current: string, out: string[]): Promise<void> {
  const entries = await readEntries(current)
  for (const e of entries) {
    const child = path.join(current, e.name)
    if (e.isDirectory()) {
      await walkFiles(child, out)
    } else if (e.isFile()) {
      out.push(child)
    }
  }
}

export class DiskVFS extends BoundVFS<DiskAccessor> implements VFS {
  declare writeFile: (p: PathSpec, data: Uint8Array) => Promise<void>

  declare appendFile: (p: PathSpec, data: Uint8Array) => Promise<void>

  declare exists: (p: PathSpec) => Promise<boolean>

  declare mkdir: (p: PathSpec, options?: { recursive?: boolean }) => Promise<void>

  declare rmdir: (p: PathSpec) => Promise<void>

  declare unlink: (p: PathSpec) => Promise<void>

  declare rename: (src: PathSpec, dst: PathSpec) => Promise<void>

  declare truncate: (p: PathSpec, length: number) => Promise<void>

  declare copy: (src: PathSpec, dst: PathSpec) => Promise<void>

  declare rmR: (p: PathSpec) => Promise<void>

  declare du: (p: PathSpec) => Promise<number>

  declare find: (p: PathSpec, options?: FindOptions) => Promise<string[]>

  readonly kind = VFSName.DISK
  readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 60
  readonly prompt = DISK_PROMPT
  readonly root: string
  readonly accessor: DiskAccessor

  constructor(options: DiskVFSOptions) {
    super(DISK_IO)
    this.root = path.resolve(options.root)
    this.accessor = new DiskAccessor(this.root)
  }

  // The resolved root is the storage: two DiskVFS instances built on the same
  // directory are one store, however they were spelled.
  override storageId(): string {
    return `${this.kind}:${this.root}`
  }

  override async open(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  // A real filesystem reports real numbers (QUOTA). GNU df: used counts
  // reserved blocks (blocks - bfree), available excludes them (bavail).
  override async statfs(): Promise<CapacityResult> {
    const st = await fsStatfs(this.root)
    const bsize = st.bsize
    return {
      state: CapacityState.QUOTA,
      total: st.blocks * bsize,
      used: (st.blocks - st.bfree) * bsize,
      available: st.bavail * bsize,
      inodes: st.files,
      inodesUsed: st.files - st.ffree,
      inodesFree: st.ffree,
    }
  }

  ops(): readonly RegisteredOp[] {
    return DISK_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return DISK_COMMANDS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override async getState(): Promise<DiskVFSState> {
    await mkdir(this.root, { recursive: true })
    const files: Record<string, Uint8Array> = {}
    const modes: Record<string, number> = {}
    const fileList: string[] = []
    await walkFiles(this.root, fileList)
    for (const full of fileList) {
      const rel = path.relative(this.root, full).split(path.sep).join('/')
      const data = await readFile(full)
      files[rel] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      // Capture the real inode mode: it is the base truth for disk
      // permissions (the sidecar is gone), so restore must reapply it or
      // a chmod would reset to the host umask.
      modes[rel] = (await fsStat(full)).mode & 0o7777
    }
    return {
      type: this.kind,
      files,
      modes,
    }
  }

  override async loadState(state: DiskVFSState): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const [rel, data] of Object.entries(state.files)) {
      if (path.isAbsolute(rel)) throw new Error(`snapshot path must be relative: ${rel}`)
      const full = await resolveInside(this.root, PathSpec.fromStrPath('/' + rel), rel)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, data)
      const mode = state.modes?.[rel]
      if (mode !== undefined) await chmod(full, mode)
    }
  }
}
