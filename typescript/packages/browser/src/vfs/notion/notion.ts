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
import { NOTION_IO } from '@struktoai/mirage-core/commands/builtin/notion/io'
import { NotionAccessor } from '@struktoai/mirage-core/accessor/notion'

import { NOTION_COMMANDS } from '@struktoai/mirage-core/commands/builtin/notion/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { MCPNotionTransport } from '@struktoai/mirage-core/core/notion/client'
import type { MCPNotionTransportOptions } from '@struktoai/mirage-core/core/notion/client'

import { NOTION_OPS } from '@struktoai/mirage-core/ops/notion/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { NOTION_PROMPT, NOTION_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/notion/prompt'
import { VFSName } from '@struktoai/mirage-core/types'

import { redactNotionConfig, type NotionConfig, type NotionConfigRedacted } from './config.ts'

export interface NotionVFSState {
  type: string
  config: NotionConfigRedacted
}

export class NotionVFS extends BoundVFS<NotionAccessor> implements VFS {
  readonly kind: string = VFSName.NOTION
  readonly cachesReads: boolean = true
  readonly prompt: string = NOTION_PROMPT
  readonly writePrompt: string = NOTION_WRITE_PROMPT
  readonly config: NotionConfig
  readonly accessor: NotionAccessor

  constructor(config: NotionConfig) {
    super(NOTION_IO)
    this.config = config
    const opts: MCPNotionTransportOptions = { authProvider: config.authProvider }
    if (config.serverUrl !== undefined) opts.serverUrl = config.serverUrl
    this.accessor = new NotionAccessor(new MCPNotionTransport(opts))
  }

  commands(): readonly RegisteredCommand[] {
    return NOTION_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return NOTION_OPS
  }

  override getState(): Promise<NotionVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactNotionConfig(this.config),
    })
  }
}
