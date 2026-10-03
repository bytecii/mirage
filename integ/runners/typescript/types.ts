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

export interface Mount {
  path: string
  resource: string
  backend: string
  mode?: string
  fixture?: string
  // Mount this prefix over an already-built mount's storage instead of
  // allocating fresh storage, so cp/mv can be exercised against two
  // prefixes that address the same bytes.
  alias_of?: string
  // Fixture seeded by the adapter (over the backend API) instead of the
  // harness tee path -- used by read-only backends like box.
  seed?: string
  // Materialise the mount's backing folder even without a fixture --
  // folder-backed services 404 on a root nothing ever created.
  seed_root?: boolean
  folder?: string
  bucket?: string
  volume?: string
  prefix?: string
  root?: string
  drive?: string
}

export interface ServiceEnv {
  python: string[]
  typescript: string[]
}

export interface Target {
  runtimes?: string[]
  mode?: 'exec'
  id: string
  hosts: string[]
  service?: string
  epoch?: string
  apps?: string
  mail?: string
  calendar?: string
  forms?: string
  dataset?: string
  agentId?: string
  facet?: string
  // Where background-job consoles live: { type: 'redis' } puts each
  // job's console on its own Redis stream (REDIS_URL). Only the ram
  // opener consults it; main.ts refuses it on any other resource.
  console?: { type?: string }
  clis?: string[]
  // Scope an installed account CLI to this mount's folder, so the CLI and
  // the mount are pointed at the same place.
  cli_scope?: string
  mounts: Mount[]
  // Sessions a case can name via its `session` field. Grants take either the
  // mapping form ({ '/data': 'read' }) or the list form (['/data'], which
  // inherits the mount's own mode).
  sessions?: Record<
    string,
    | Record<string, string>
    | string[]
    | {
        mounts?: Record<string, string> | string[]
        hidden_paths?: { paths?: string[]; patterns?: string[] }
        hidden_vars?: { names?: string[]; patterns?: string[] }
        env?: Record<string, string>
      }
  >
  // Session environment every case on this target runs under. The
  // conformance runner passes the same map to the real binary, so a CLI
  // option that reads a variable is compared under one environment.
  env?: Record<string, string>
}

export interface Expect {
  exit: number
  stdout: string
  stderr: string
  // The stat line the case's `check` must produce, asserted alongside stdout
  // rather than in place of it.
  check?: string
  elapsed?: { min: number; max: number }
}

export interface StatCheck {
  stat?: string
  fields?: string[]
  read?: string
  offset?: number
  size?: number | null
}

export interface ExecutionCase {
  command: string
  lifecycle?: 'cancel' | 'kill' | 'close'
  setup?: string
  concurrent?: ExecutionCase[]
  timeout_seconds?: number
  env?: Record<string, string>
  cwd?: string
  flags?: string[]
  check?: StatCheck
  provision?: boolean
  clear_cache?: boolean
  consistency?: 'always' | 'lazy'
  session?: string
  scenario?: ScenarioStep[]
  expect: Expect
}

export interface Case extends ExecutionCase {
  id: string
  seq?: number
  targets: string[]
  _source?: string
}

export type ScenarioStep = { mutate: { path: string; content: string } } | { command: string }

export interface ProvisionInfo {
  networkRead: number | string
  networkWrite: number | string
  cacheRead: number | string
  readOps: number
  cacheHits: number
  precision: string
}

export interface ProvisionExec {
  execute(cmd: string, opts: { provision: true }): Promise<ProvisionInfo>
}

export interface ExecResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
}

export interface HarnessStat {
  mode: number | null
  uid: number | string | null
  gid: number | string | null
  modified: string | null
}

export interface ExecWorkspace {
  execute(
    cmd: string,
    opts?: {
      stdin?: Uint8Array
      sessionId?: string
      env?: Record<string, string>
      cwd?: string
      signal?: AbortSignal
    },
  ): Promise<ExecResult>
  dispatch(
    opName: string,
    path: string,
    args?: readonly unknown[],
    kwargs?: Record<string, unknown>,
  ): Promise<unknown>
  cache: { clear(): Promise<void> }
  mounts(): readonly { resource: { index?: { clear(): Promise<void> } } }[]
  createSession(sessionId: string, options: { mounts: Record<string, string> | string[] }): unknown
  env: Record<string, string>
  close(): Promise<void>
}
