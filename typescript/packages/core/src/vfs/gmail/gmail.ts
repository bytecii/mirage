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

import { GmailAccessor } from '../../accessor/gmail.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { GMAIL_COMMANDS } from '../../commands/builtin/gmail/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { read as gmailRead } from '../../core/gmail/read.ts'
import { readdir as gmailReaddir } from '../../core/gmail/readdir.ts'
import { stat as gmailStat } from '../../core/gmail/stat.ts'
import { TokenManager } from '../../core/google/client.ts'
import { GMAIL_OPS } from '../../ops/gmail/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseVFS } from '../base.ts'
import type { VFS } from '../base.ts'
import { GMAIL_PROMPT, GMAIL_WRITE_PROMPT } from './prompt.ts'
import { PathSpec, VFSName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { redactGmailConfig, type GmailConfig, type GmailConfigRedacted } from './config.ts'

const gmailResolveGlob = makeResolveGlob(gmailReaddir)

export interface GmailVFSState {
  type: string
  config: GmailConfigRedacted
}

export class GmailVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GMAIL
  readonly cachesReads: boolean = true
  // Every listed file carries an exact size: .gmail.json is rendered at
  // readdir from the full message the listing already fetched, and
  // attachments carry the decoded byte count.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GMAIL_PROMPT
  readonly writePrompt: string = GMAIL_WRITE_PROMPT
  readonly config: GmailConfig
  readonly accessor: GmailAccessor

  constructor(config: GmailConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GmailAccessor({ tokenManager: tm })
  }

  commands(): readonly RegisteredCommand[] {
    return GMAIL_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GMAIL_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gmailRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gmailReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gmailStat(this.accessor, p, this.index)
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
    return gmailResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GmailVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGmailConfig(this.config),
    })
  }
}
