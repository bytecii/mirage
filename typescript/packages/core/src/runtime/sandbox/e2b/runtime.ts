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

import { RemoteSandbox } from '../base.ts'
import { registerRuntime } from '../../table.ts'
import type { RunResult, RuntimeOptions } from '../../types.ts'
import { loadOptionalPeer } from '../../../utils/optional_peer.ts'
import { E2B_CONFIG_KEYS, type E2BConfig } from './config.ts'
import type { CommandResult, Sandbox } from 'e2b'
import type * as e2bSdk from 'e2b'

export type E2bSdk = typeof e2bSdk

const ENC = new TextEncoder()

/**
 * An E2B sandbox the user runs as a whole-line runtime.
 *
 * You create the sandbox yourself (`e2b sandbox spawn` or the SDK);
 * mirage only connects by `sandboxId` and execs lines. `apiKey` falls
 * back to E2B_API_KEY. E2B's exec reports stdout and stderr
 * separately. Piped bytes use native stdin followed by an explicit
 * EOF; no input closes stdin when the command starts.
 */
export class E2BRuntime extends RemoteSandbox<E2BConfig> {
  readonly name = 'e2b'
  private sdk: E2bSdk | null = null
  private sandbox: Sandbox | null = null

  constructor(options: RuntimeOptions<E2BConfig> | Record<string, unknown> = {}) {
    super(options, E2B_CONFIG_KEYS)
    if (!this.config.sandboxId) {
      throw new Error('e2b config needs sandboxId: the id of a live sandbox you created')
    }
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<E2bSdk> {
    return loadOptionalPeer(() => import('e2b'), {
      feature: "the 'e2b' runtime",
      packageName: 'e2b',
    })
  }

  private async ensureSdk(): Promise<E2bSdk> {
    this.sdk ??= await this.loadSdk()
    return this.sdk
  }

  private apiParams(): Record<string, unknown> {
    return this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}
  }

  async connect(): Promise<void> {
    const sdk = await this.ensureSdk()
    this.sandbox = await sdk.Sandbox.connect(this.config.sandboxId, this.apiParams())
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    if (this.sandbox === null) throw new Error('e2b sandbox not connected')
    const sdk = await this.ensureSdk()
    const handle = await this.sandbox.commands.run(line, {
      envs: env,
      cwd,
      background: true,
      stdin: stdin !== null,
    })
    let result: Pick<CommandResult, 'stdout' | 'stderr' | 'exitCode'>
    try {
      try {
        if (stdin !== null) {
          if (stdin.byteLength > 0) await handle.sendStdin(stdin)
          await handle.closeStdin()
        }
      } catch (error) {
        // The command may exit before the input RPC arrives. Wait for its
        // real exit status rather than reporting the missing process as I/O.
        // Process RPCs still throw this SDK class; no process-specific replacement exists.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        if (!(error instanceof sdk.NotFoundError)) throw error
      }
      result = await handle.wait()
    } catch (error) {
      if (error instanceof sdk.CommandExitError) {
        result = error
      } else {
        try {
          await handle.kill()
        } catch (cleanupError) {
          console.warn('Failed to stop the E2B command', cleanupError)
        }
        throw error
      }
    } finally {
      await handle.disconnect()
    }
    return {
      stdout: ENC.encode(result.stdout),
      stderr: ENC.encode(result.stderr),
      exitCode: result.exitCode,
    }
  }
}

registerRuntime('e2b', E2BRuntime)
