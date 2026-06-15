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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  createShellParser,
  type ExecuteOptions,
  type ExecuteResult,
  type ProvisionResult,
  type Resource,
  type ShellParser,
  Workspace as CoreWorkspace,
  type WorkspaceOptions,
} from '@struktoai/mirage-core'
import { FuseManager } from './workspace/fuse.ts'

const requireCjs = createRequire(import.meta.url)

let cachedParser: Promise<ShellParser> | null = null

function loadShellParser(): Promise<ShellParser> {
  if (cachedParser !== null) return cachedParser
  const enginePath = requireCjs.resolve('web-tree-sitter/web-tree-sitter.wasm')
  const grammarPath = requireCjs.resolve('tree-sitter-bash/tree-sitter-bash.wasm')
  cachedParser = createShellParser({
    engineWasm: readFileSync(enginePath),
    grammarWasm: readFileSync(grammarPath),
  })
  return cachedParser
}

export interface NodeWorkspaceOptions extends WorkspaceOptions {
  fuse?: boolean
}

export class Workspace extends CoreWorkspace {
  private readonly autoFuseManager: FuseManager | null
  private fuseSetupPromise: Promise<void> | null = null

  constructor(resources: Record<string, Resource>, options: NodeWorkspaceOptions = {}) {
    super(resources, {
      ...options,
      shellParserFactory: options.shellParserFactory ?? loadShellParser,
    })
    this.autoFuseManager = options.fuse === true ? new FuseManager() : null
    if (this.autoFuseManager !== null) {
      // Kick off mount eagerly; await inside execute() / close() so callers
      // don't need to await the constructor. Python mirrors this: fuse=True
      // runs setup() during __init__ and __enter__ just returns self.
      //
      // A failed auto-mount (e.g. libfuse absent on the host) degrades to an
      // unmounted but fully usable workspace, mirroring Python: there the mount
      // runs on a daemon thread so its failure never reaches the main process.
      // On Node's single event loop we must swallow it here, otherwise the
      // unhandled rejection would terminate the process under Node's default
      // unhandled-rejection policy.
      const fm = this.autoFuseManager
      this.fuseSetupPromise = fm.setup(this).then(
        () => undefined,
        (err: unknown) => {
          process.stderr.write(
            `mirage: FUSE auto-mount failed, continuing without it: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          )
        },
      )
    }
  }

  private async ensureFuseReady(): Promise<void> {
    if (this.fuseSetupPromise !== null) {
      await this.fuseSetupPromise
      this.fuseSetupPromise = null
    }
  }

  override execute(
    command: string,
    options?: ExecuteOptions & { provision?: false | undefined },
  ): Promise<ExecuteResult>
  override execute(
    command: string,
    options: ExecuteOptions & { provision: true },
  ): Promise<ProvisionResult>
  override execute(
    command: string,
    options: ExecuteOptions,
  ): Promise<ExecuteResult | ProvisionResult>
  override async execute(
    command: string,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult | ProvisionResult> {
    await this.ensureFuseReady()
    return super.execute(command, options)
  }

  override async close(): Promise<void> {
    await this.ensureFuseReady().catch(() => undefined)
    if (this.autoFuseManager !== null) {
      await this.autoFuseManager.close(this)
    }
    await super.close()
  }
}
