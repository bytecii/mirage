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
import { S3_IO } from '@struktoai/mirage-core/commands/builtin/s3/io'
import { S3Accessor } from '@struktoai/mirage-core/accessor/s3'

import { S3_COMMANDS } from '@struktoai/mirage-core/commands/builtin/s3/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'

import { buildDeltaHook } from '@struktoai/mirage-core/core/s3/watch'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { S3_OPS } from '@struktoai/mirage-core/ops/s3/index'

import type { FindOptions, VFS } from '@struktoai/mirage-core/vfs/base'
import { s3StorageId } from '@struktoai/mirage-core/vfs/s3/storage_id'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { VFSName } from '@struktoai/mirage-core/types'

import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { redactConfig, type S3Config, type S3ConfigRedacted } from './config.ts'

export const S3_BROWSER_PROMPT = `{prefix}
  Remote S3 bucket accessed via presigned URLs (browser runtime).
  Supports the full filesystem command set: ls/tree/cat/grep/find/du/cp/mv/rm/etc.
  Listing operations require the presigner to sign LIST/COPY operations in
  addition to GET/PUT/HEAD/DELETE — see S3BrowserPresignedUrlProvider docs.`

export interface S3VFSState {
  type: string
  config: S3ConfigRedacted
}

export class S3VFS extends BoundVFS<S3Accessor> implements VFS {
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

  readonly supportsSnapshot: boolean = true
  readonly kind: string = VFSName.S3
  readonly cachesReads: boolean = true
  // A HEAD carries ContentLength, so a size is always knowable without
  // fetching. Every sibling browser VFS says so; s3 was the one that
  // did not, and its node twin has always declared it.
  readonly sizesAlwaysKnown: boolean = true
  // stat and read both stamp the ETag, so the gate compares like with
  // like. Inherited by every S3AliasVFS provider.
  readonly readRevalidatable: boolean = true
  readonly prompt: string = S3_BROWSER_PROMPT
  readonly config: S3Config
  readonly accessor: S3Accessor

  constructor(config: S3Config) {
    super(S3_IO)
    this.config = config
    this.accessor = new S3Accessor(this.config)
  }

  // Without this, two mounts of one bucket at different prefixes are two
  // storages, so `mv` between them copies an object over itself and then
  // unlinks the source. Node has always declared it; the shared helper keeps
  // the two runtimes from computing different identities for one bucket.
  override storageId(): string {
    return s3StorageId(this.kind, this.config)
  }

  commands(): readonly RegisteredCommand[] {
    return S3_COMMANDS.toArray()
  }

  ops(): readonly RegisteredOp[] {
    return S3_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<S3VFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactConfig(this.config),
    })
  }
}
