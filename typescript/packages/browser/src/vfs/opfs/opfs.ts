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
import { OPFS_IO } from '../../commands/builtin/opfs/io.ts'

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import type { FindOptions, VFS } from '@struktoai/mirage-core/vfs/base'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { lstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { OPFSAccessor } from '../../accessor/opfs.ts'
import { OPFS_COMMANDS } from '../../commands/builtin/opfs/index.ts'

import { iterEntries, toWritableChunk } from '../../core/opfs/utils.ts'

import { OPFS_OPS } from '../../ops/opfs/index.ts'
import { OPFS_PROMPT } from './prompt.ts'

export interface OPFSVFSOptions {
  root?: string
}

export interface OPFSVFSState {
  type: string
  files: Record<string, Uint8Array>
  dirs: string[]
}

async function walkFiles(
  dir: FileSystemDirectoryHandle,
  currentPath: string,
  files: Record<string, Uint8Array>,
): Promise<void> {
  for await (const [name, handle] of iterEntries(dir)) {
    const childPath = currentPath === '' ? name : `${currentPath}/${name}`
    if (handle.kind === 'file') {
      const fh = await dir.getFileHandle(name, { create: false })
      const file = await fh.getFile()
      files[childPath] = new Uint8Array(await file.arrayBuffer())
    } else {
      const child = await dir.getDirectoryHandle(name, { create: false })
      await walkFiles(child, childPath, files)
    }
  }
}

async function walkDirs(
  dir: FileSystemDirectoryHandle,
  currentPath: string,
  dirs: string[],
): Promise<void> {
  for await (const [name, handle] of iterEntries(dir)) {
    if (handle.kind !== 'directory') continue
    const childPath = currentPath === '' ? `/${name}` : `${currentPath}/${name}`
    dirs.push(childPath)
    const child = await dir.getDirectoryHandle(name, { create: false })
    await walkDirs(child, childPath, dirs)
  }
}

async function splitAndCreate(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemDirectoryHandle> {
  let handle = root
  for (const seg of relativePath.split('/')) {
    if (seg === '' || seg === '.') continue
    handle = await handle.getDirectoryHandle(seg, { create: true })
  }
  return handle
}

export class OPFSVFS extends BoundVFS<OPFSAccessor> implements VFS {
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

  readonly kind = VFSName.OPFS
  // OPFS is a real filesystem: getFile().size is the exact byte count a
  // read returns.
  readonly sizesAlwaysKnown: boolean = true
  readonly prompt = OPFS_PROMPT
  readonly rootName: string
  readonly accessor: OPFSAccessor
  private rootHandle: FileSystemDirectoryHandle | null = null
  private openPromise: Promise<FileSystemDirectoryHandle> | null = null

  constructor(options: OPFSVFSOptions = {}) {
    super(OPFS_IO)
    this.rootName = options.root ?? ''
    this.accessor = new OPFSAccessor(this)
  }

  override open(): Promise<void> {
    return this.ensureOpen().then(() => undefined)
  }

  override async close(): Promise<void> {
    this.rootHandle = null
    this.openPromise = null
    await super.close()
  }

  /**
   * Lazily resolve to a usable root handle. Memoizes `navigator.storage`
   * traversal so the VFS self-initializes on first method call without
   * relying on an external orchestrator.
   */
  private ensureOpen(): Promise<FileSystemDirectoryHandle> {
    if (this.rootHandle !== null) return Promise.resolve(this.rootHandle)
    this.openPromise ??= (async () => {
      const origin = await navigator.storage.getDirectory()
      let handle = origin
      for (const seg of this.rootName.split('/')) {
        if (seg === '' || seg === '.') continue
        handle = await handle.getDirectoryHandle(seg, { create: true })
      }
      this.rootHandle = handle
      return handle
    })()
    return this.openPromise
  }

  requireHandle(): FileSystemDirectoryHandle {
    if (this.rootHandle === null) {
      throw new Error('OPFSVFS is not open — call open() first')
    }
    return this.rootHandle
  }

  ops(): readonly RegisteredOp[] {
    return OPFS_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return OPFS_COMMANDS
  }

  override async getState(): Promise<OPFSVFSState> {
    const handle = await this.ensureOpen()
    const files: Record<string, Uint8Array> = {}
    await walkFiles(handle, '', files)
    const dirs: string[] = []
    await walkDirs(handle, '', dirs)
    dirs.sort(compareCodePoints)
    return {
      type: this.kind,
      files,
      dirs,
    }
  }

  override async loadState(state: OPFSVFSState): Promise<void> {
    const handle = await this.ensureOpen()
    for (const dir of state.dirs) {
      const rel = lstripSlash(dir)
      if (rel === '') continue
      await splitAndCreate(handle, rel)
    }
    for (const [rel, data] of Object.entries(state.files)) {
      const segs = rel.split('/').filter((s) => s !== '' && s !== '.')
      const fileName = segs.pop()
      if (fileName === undefined) continue
      let dir = handle
      for (const seg of segs) {
        dir = await dir.getDirectoryHandle(seg, { create: true })
      }
      const fh = await dir.getFileHandle(fileName, { create: true })
      const writable = await fh.createWritable()
      await writable.write(toWritableChunk(data))
      await writable.close()
    }
  }
}
