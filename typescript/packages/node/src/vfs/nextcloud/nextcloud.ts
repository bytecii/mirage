import { BoundVFS } from '@struktoai/mirage-core/vfs/bound'
import { NEXTCLOUD_IO } from '../../commands/builtin/nextcloud/io.ts'

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import type { FindOptions, VFS } from '@struktoai/mirage-core/vfs/base'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { VFSName } from '@struktoai/mirage-core/types'

import type { DeltaHook } from '@struktoai/mirage-core/watch/index'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { NEXTCLOUD_COMMANDS } from '../../commands/builtin/nextcloud/index.ts'

import { buildDeltaHook } from '../../core/nextcloud/watch.ts'
import { NEXTCLOUD_OPS } from '../../ops/nextcloud/index.ts'
import {
  redactNextcloudConfig,
  type NextcloudConfig,
  type NextcloudConfigRedacted,
} from './config.ts'
import { NEXTCLOUD_PROMPT } from './prompt.ts'

export interface NextcloudVFSState {
  type: string
  config: NextcloudConfigRedacted
}

export class NextcloudVFS extends BoundVFS<NextcloudAccessor> implements VFS {
  declare appendFile: (path: PathSpec, data: Uint8Array) => Promise<void>

  declare writeFile: (path: PathSpec, data: Uint8Array) => Promise<void>

  declare exists: (path: PathSpec) => Promise<boolean>

  declare mkdir: (path: PathSpec) => Promise<void>

  declare rmdir: (path: PathSpec) => Promise<void>

  declare unlink: (path: PathSpec) => Promise<void>

  declare rename: (source: PathSpec, destination: PathSpec) => Promise<void>

  declare truncate: (path: PathSpec, length: number) => Promise<void>

  declare copy: (source: PathSpec, destination: PathSpec) => Promise<void>

  declare rmR: (path: PathSpec) => Promise<void>

  declare du: (path: PathSpec) => Promise<number>

  declare find: (path: PathSpec, options?: FindOptions) => Promise<string[]>

  readonly kind = VFSName.NEXTCLOUD
  readonly cachesReads = true
  // WebDAV PROPFIND carries getcontentlength for every file; readdir
  // backfills any lister-omitted size with one stat per affected file.
  readonly sizesAlwaysKnown: boolean = true
  readonly supportsSnapshot = true
  readonly prompt = NEXTCLOUD_PROMPT
  readonly accessor: NextcloudAccessor

  constructor(readonly config: NextcloudConfig) {
    super(NEXTCLOUD_IO)
    this.accessor = new NextcloudAccessor(config)
  }

  commands(): readonly RegisteredCommand[] {
    return NEXTCLOUD_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return NEXTCLOUD_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<NextcloudVFSState> {
    return Promise.resolve({ type: this.kind, config: redactNextcloudConfig(this.config) })
  }
}
