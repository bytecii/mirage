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
import { MONGODB_IO } from '@struktoai/mirage-core/commands/builtin/mongodb/io'
import { MongoDBAccessor } from '@struktoai/mirage-core/accessor/mongodb'

import { MONGODB_COMMANDS } from '@struktoai/mirage-core/commands/builtin/mongodb/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { MongoDriver } from '@struktoai/mirage-core/core/mongodb/_driver'

import { MONGODB_OPS } from '@struktoai/mirage-core/ops/mongodb/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import type { VFS } from '@struktoai/mirage-core/vfs/base'
import {
  redactMongoDBConfig,
  resolveMongoDBConfig,
} from '@struktoai/mirage-core/vfs/mongodb/config'
import type {
  MongoDBConfig,
  MongoDBConfigRedacted,
  MongoDBConfigResolved,
} from '@struktoai/mirage-core/vfs/mongodb/config'
import { MONGODB_PROMPT } from '@struktoai/mirage-core/vfs/mongodb/prompt'
import { VFSName } from '@struktoai/mirage-core/types'

import { HttpMongoDriver } from './http_driver.ts'

export interface MongoDBVFSOptions {
  config: MongoDBConfig
  prefix?: string
  driver?: MongoDriver
  endpoint?: string
}

export interface MongoDBVFSState {
  type: string
  config: MongoDBConfigRedacted
  needs_override: true
}

export class MongoDBVFS extends BoundVFS<MongoDBAccessor> implements VFS {
  readonly kind: string = VFSName.MONGODB
  readonly cachesReads: boolean = false
  override readonly indexTtl: number = 0
  readonly prompt: string
  readonly config: MongoDBConfigResolved
  readonly driver: MongoDriver
  readonly accessor: MongoDBAccessor

  constructor(options: MongoDBVFSOptions | MongoDBConfig) {
    super(MONGODB_IO)
    const { config, prefix, driver, endpoint } =
      'config' in options
        ? options
        : { config: options, prefix: undefined, driver: undefined, endpoint: undefined }
    this.config = resolveMongoDBConfig(config)
    this.driver = driver ?? new HttpMongoDriver({ endpoint: endpoint ?? this.config.uri })
    this.accessor = new MongoDBAccessor(this.driver, this.config)
    this.prompt = MONGODB_PROMPT.replace('{prefix}', prefix ?? '')
  }

  override getState(): MongoDBVFSState {
    return {
      type: this.kind,
      config: redactMongoDBConfig(this.config),
      // TypeScript cannot rebuild a config-backed mount from state:
      // `buildMountArgs` substitutes a RAMVFS for anything it was
      // not handed. Saying so out loud turns a silently empty mount
      // into a refusal to load. Python rebuilds via its registry, so it
      // writes this on only four mounts and reads it nowhere.
      needs_override: true,
    }
  }

  override async close(): Promise<void> {
    await this.driver.close()
    await super.close()
  }

  ops(): readonly RegisteredOp[] {
    return MONGODB_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return MONGODB_COMMANDS
  }
}
