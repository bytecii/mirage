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
import './compression_codecs.ts'

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
  /**
   * Per-mount FUSE exposure: `{ '/data': true, '/s3': '/tmp/s3' }`. A value of
   * `true` mounts at a fresh temp dir; a string pins the mountpoint (created if
   * missing). Each entry becomes its own FUSE mount scoped to that prefix.
   */
  fuseMounts?: Record<string, boolean | string>
}

export class Workspace extends CoreWorkspace {
  private readonly autoFuseManagers = new Map<string, FuseManager>()
  private readonly fuseMountpointsMap = new Map<string, string>()
  private fuseSetupPromise: Promise<void> | null = null

  constructor(resources: Record<string, Resource>, options: NodeWorkspaceOptions = {}) {
    super(resources, {
      ...options,
      shellParserFactory: options.shellParserFactory ?? loadShellParser,
    })
    const fuseMounts = options.fuseMounts ?? {}
    const setups: Promise<void>[] = []
    for (const [prefix, target] of Object.entries(fuseMounts)) {
      if (target === false) continue
      const fm = new FuseManager()
      this.autoFuseManagers.set(prefix, fm)
      const opts = {
        rootPrefix: prefix,
        ...(typeof target === 'string' ? { mountpoint: target } : {}),
      }
      // Kick off mount eagerly; await inside execute() / close() so callers
      // don't need to await the constructor (Python mirrors this).
      //
      // A failed auto-mount (e.g. libfuse absent on the host) degrades to an
      // unmounted but fully usable workspace, mirroring Python: there the mount
      // runs on a daemon thread so its failure never reaches the main process.
      // On Node's single event loop we must swallow it here, otherwise the
      // unhandled rejection would terminate the process under Node's default
      // unhandled-rejection policy.
      setups.push(
        fm.setup(this, opts).then(
          (mountpoint) => {
            this.fuseMountpointsMap.set(prefix, mountpoint)
          },
          (err: unknown) => {
            process.stderr.write(
              `mirage: FUSE auto-mount failed for ${prefix}, continuing without it: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            )
          },
        ),
      )
    }
    if (setups.length > 0) {
      this.fuseSetupPromise = Promise.all(setups).then(() => undefined)
    }
  }

  /** Map each FUSE-exposed mount prefix to its live mountpoint. */
  get fuseMountpoints(): Record<string, string> {
    return Object.fromEntries(this.fuseMountpointsMap)
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
    for (const fm of this.autoFuseManagers.values()) {
      await fm.close(this)
    }
    await super.close()
  }
}
