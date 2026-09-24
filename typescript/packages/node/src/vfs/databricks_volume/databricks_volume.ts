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
import { DATABRICKS_VOLUME_IO } from '@struktoai/mirage-core/commands/builtin/databricks_volume/io'
import { DatabricksVolumeAccessor } from '@struktoai/mirage-core/accessor/databricks_volume'
import { DATABRICKS_VOLUME_COMMANDS } from '@struktoai/mirage-core/commands/builtin/databricks_volume/index'

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'

import { DATABRICKS_VOLUME_OPS } from '@struktoai/mirage-core/ops/databricks_volume/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import type { FindOptions, VFS } from '@struktoai/mirage-core/vfs/base'
import { DATABRICKS_VOLUME_PROMPT } from '@struktoai/mirage-core/vfs/databricks_volume/prompt'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { VFSName } from '@struktoai/mirage-core/types'

import {
  redactDatabricksVolumeConfig,
  type DatabricksVolumeConfig,
  type DatabricksVolumeConfigRedacted,
} from './config.ts'
import { loadDatabricksProfile } from './profile.ts'

export interface DatabricksVolumeVFSState {
  type: string
  config: DatabricksVolumeConfigRedacted
}

async function resolveAuth(config: DatabricksVolumeConfig): Promise<[string, string]> {
  let host = config.host ?? process.env.DATABRICKS_HOST
  let token = config.token ?? process.env.DATABRICKS_TOKEN
  if (host === undefined || host === '' || token === undefined || token === '') {
    const profileName = config.profile ?? process.env.DATABRICKS_CONFIG_PROFILE ?? 'DEFAULT'
    const profile = await loadDatabricksProfile(profileName)
    host = host !== undefined && host !== '' ? host : profile.host
    token = token !== undefined && token !== '' ? token : profile.token
  }
  if (host === undefined || host === '' || token === undefined || token === '') {
    throw new Error(
      'databricks_volume: missing credentials; set host/token in the config, ' +
        'DATABRICKS_HOST/DATABRICKS_TOKEN env vars, or a ~/.databrickscfg profile',
    )
  }
  return [host, token]
}

export class DatabricksVolumeVFS extends BoundVFS<DatabricksVolumeAccessor> implements VFS {
  declare appendFile: (path: PathSpec, data: Uint8Array) => Promise<void>

  declare writeFile: (p: PathSpec, data: Uint8Array) => Promise<void>

  declare exists: (p: PathSpec) => Promise<boolean>

  declare mkdir: (p: PathSpec) => Promise<void>

  declare rmdir: (p: PathSpec) => Promise<void>

  declare unlink: (p: PathSpec) => Promise<void>

  declare rename: (src: PathSpec, dst: PathSpec) => Promise<void>

  declare copy: (src: PathSpec, dst: PathSpec) => Promise<void>

  declare rmR: (p: PathSpec) => Promise<void>

  declare find: (p: PathSpec, options?: FindOptions) => Promise<string[]>

  readonly kind: string = VFSName.DATABRICKS_VOLUME
  readonly cachesReads: boolean = true
  // The Files API lists DirectoryEntry.file_size and stat HEADs report
  // Content-Length, both the exact byte count the download returns;
  // readdir backfills any lister-omitted size with one HEAD.
  readonly sizesAlwaysKnown: boolean = true
  readonly prompt: string = DATABRICKS_VOLUME_PROMPT
  readonly config: DatabricksVolumeConfig
  readonly accessor: DatabricksVolumeAccessor

  private constructor(config: DatabricksVolumeConfig, accessor: DatabricksVolumeAccessor) {
    super(DATABRICKS_VOLUME_IO)
    this.config = config
    this.accessor = accessor
  }

  static async create(config: DatabricksVolumeConfig): Promise<DatabricksVolumeVFS> {
    const [host, token] = await resolveAuth(config)
    const accessor = new DatabricksVolumeAccessor(config, host, token)
    return new DatabricksVolumeVFS(config, accessor)
  }

  commands(): readonly RegisteredCommand[] {
    return DATABRICKS_VOLUME_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return DATABRICKS_VOLUME_OPS
  }

  override getState(): Promise<DatabricksVolumeVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactDatabricksVolumeConfig(this.config),
    })
  }
}
