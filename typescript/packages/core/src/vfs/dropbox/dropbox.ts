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

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { DROPBOX_COMMANDS } from '../../commands/builtin/dropbox/index.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { DropboxTokenManager } from '../../core/dropbox/client.ts'
import { read as dropboxRead } from '../../core/dropbox/read.ts'
import { readdir as dropboxReaddir } from '../../core/dropbox/readdir.ts'
import { stat as dropboxStat } from '../../core/dropbox/stat.ts'
import { DROPBOX_OPS } from '../../ops/dropbox/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../base.ts'
import type { VFS } from '../base.ts'
import { DROPBOX_PROMPT } from './prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { redactDropboxConfig, type DropboxConfig, type DropboxConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/dropbox/watch.ts'
import { type DeltaHook } from '../../watch/index.ts'

const dropboxResolveGlob = makeResolveGlob(dropboxReaddir)

export interface DropboxVFSState {
  type: string
  config: DropboxConfigRedacted
}

export class DropboxVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.DROPBOX
  readonly cachesReads: boolean = true
  // list_folder carries an exact byte `size` for every file (0 included).
  // Paper docs 409 on raw download, a loud error, never a silent empty read.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = DROPBOX_PROMPT
  readonly config: DropboxConfig
  readonly accessor: DropboxAccessor

  constructor(config: DropboxConfig) {
    super()
    this.config = config
    const tm = new DropboxTokenManager(config)
    this.accessor = new DropboxAccessor({
      tokenManager: tm,
      ...(config.rootPath !== undefined ? { rootPath: config.rootPath } : {}),
      ...(config.contentSearch !== undefined ? { contentSearch: config.contentSearch } : {}),
    })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return DROPBOX_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return DROPBOX_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return dropboxRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return dropboxReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return dropboxStat(this.accessor, p, this.index)
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
    return dropboxResolveGlob(this.accessor, effective, this.index)
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<DropboxVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactDropboxConfig(this.config),
    })
  }

  override loadState(_state: DropboxVFSState): Promise<void> {
    return Promise.resolve()
  }
}
