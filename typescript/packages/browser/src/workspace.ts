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

import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { decodeBase64 } from '@struktoai/mirage-core/utils/base64'
import { createShellParser } from '@struktoai/mirage-core/shell/parse'
import type { ShellParser } from '@struktoai/mirage-core/shell/parse'
import { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { WorkspaceOptions } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { MountSpec } from '@struktoai/mirage-core/workspace/workspace/types'
import { savedVfsBuild } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { MountSnapshot } from '@struktoai/mirage-core/workspace/snapshot/types'
import { buildVfs, knownVfsNames } from './vfs/registry.ts'
import { ENGINE_WASM_BASE64, GRAMMAR_WASM_BASE64 } from './generated/wasm.ts'

let cachedParser: Promise<ShellParser> | null = null

function loadShellParser(): Promise<ShellParser> {
  if (cachedParser !== null) return cachedParser
  cachedParser = createShellParser({
    engineWasm: decodeBase64(ENGINE_WASM_BASE64),
    grammarWasm: decodeBase64(GRAMMAR_WASM_BASE64),
  })
  return cachedParser
}

export class Workspace extends CoreWorkspace {
  /** A saved mount rebuilds through this package's VFS registry. */
  protected static override async buildSavedVfs(entry: MountSnapshot): Promise<BaseVFS | null> {
    const build = savedVfsBuild(entry, (name) => knownVfsNames().includes(name))
    return build === null ? null : buildVfs(build.name, build.config)
  }

  constructor(mounts: Record<string, MountSpec>, options: WorkspaceOptions = {}) {
    super(mounts, {
      ...options,
      shellParserFactory: options.shellParserFactory ?? loadShellParser,
    })
  }
}
