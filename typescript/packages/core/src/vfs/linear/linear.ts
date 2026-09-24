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
import { LINEAR_IO } from '../../commands/builtin/linear/io.ts'
import { LinearAccessor } from '../../accessor/linear.ts'

import { LINEAR_COMMANDS } from '../../commands/builtin/linear/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { HttpLinearTransport } from '../../core/linear/client.ts'
import { redactLinearConfig } from '../../core/linear/config.ts'
import type { LinearConfig, LinearConfigRedacted } from '../../core/linear/config.ts'

import { LINEAR_OPS } from '../../ops/linear/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import type { VFS } from '../base.ts'
import { LINEAR_PROMPT, LINEAR_WRITE_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

export interface LinearVFSState {
  type: string
  config: LinearConfigRedacted
}

export class LinearVFS extends BoundVFS<LinearAccessor> implements VFS {
  readonly kind: string = VFSName.LINEAR
  readonly cachesReads: boolean = true
  // Every file is sized at its parent's readdir from the listing payload
  // (comments.jsonl via one bounded comments call), so stat always reports
  // the rendered byte length and fskit mounts serve exact reads.
  readonly sizesAlwaysKnown: boolean = true
  readonly prompt: string = LINEAR_PROMPT
  readonly writePrompt: string = LINEAR_WRITE_PROMPT
  readonly config: LinearConfig
  readonly accessor: LinearAccessor

  constructor(config: LinearConfig) {
    super(LINEAR_IO)
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string } = { apiKey: config.apiKey }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: { teamIds?: readonly string[] } = {}
    if (config.teamIds !== undefined) accessorOpts.teamIds = config.teamIds
    this.accessor = new LinearAccessor(new HttpLinearTransport(transportOpts), accessorOpts)
  }

  commands(): readonly RegisteredCommand[] {
    return LINEAR_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return LINEAR_OPS
  }

  override getState(): Promise<LinearVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactLinearConfig(this.config),
    })
  }
}
