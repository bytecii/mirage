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
import { LANGFUSE_IO } from '../../commands/builtin/langfuse/io.ts'
import { LangfuseAccessor } from '../../accessor/langfuse.ts'

import { LANGFUSE_COMMANDS } from '../../commands/builtin/langfuse/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { HttpLangfuseTransport } from '../../core/langfuse/client.ts'

import { LANGFUSE_OPS } from '../../ops/langfuse/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import type { VFS } from '../base.ts'
import { LANGFUSE_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactLangfuseConfig, type LangfuseConfig, type LangfuseConfigRedacted } from './config.ts'

export interface LangfuseVFSState {
  type: string
  config: LangfuseConfigRedacted
}

export class LangfuseVFS extends BoundVFS<LangfuseAccessor> implements VFS {
  readonly kind: string = VFSName.LANGFUSE
  readonly cachesReads: boolean = true
  readonly prompt: string = LANGFUSE_PROMPT
  readonly config: LangfuseConfig
  readonly accessor: LangfuseAccessor

  constructor(config: LangfuseConfig) {
    super(LANGFUSE_IO)
    this.config = config
    const transportOpts: { publicKey: string; secretKey: string; host?: string } = {
      publicKey: config.publicKey,
      secretKey: config.secretKey,
    }
    if (config.host !== undefined) transportOpts.host = config.host
    const accessorConfig: {
      defaultTraceLimit?: number
      defaultSearchLimit?: number
      defaultFromTimestamp?: string
    } = {}
    if (config.defaultTraceLimit !== undefined) {
      accessorConfig.defaultTraceLimit = config.defaultTraceLimit
    }
    if (config.defaultSearchLimit !== undefined) {
      accessorConfig.defaultSearchLimit = config.defaultSearchLimit
    }
    if (config.defaultFromTimestamp !== undefined) {
      accessorConfig.defaultFromTimestamp = config.defaultFromTimestamp
    }
    this.accessor = new LangfuseAccessor(new HttpLangfuseTransport(transportOpts), accessorConfig)
  }

  commands(): readonly RegisteredCommand[] {
    return LANGFUSE_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return LANGFUSE_OPS
  }

  override getState(): Promise<LangfuseVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactLangfuseConfig(this.config),
    })
  }
}
