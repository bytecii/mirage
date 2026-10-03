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

import type { DispatchFn } from '../../runtime/types.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { PolicyDecision } from '../../runtime/policy/index.ts'
import type { Resource } from '../../resource/base.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'

import type { ByteSource, IOResult } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { Session } from '../session/session.ts'
import type { ExecutionNode } from '../types.ts'

/** Per-call overrides a caller can layer onto the walker's deps. */
export interface ExecuteNodeOpts {
  sink?: JobConsole
  signal?: AbortSignal
}

export type ExecuteNodeFn = (
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
) => Promise<[ByteSource | null, IOResult, ExecutionNode]>

export type ExecutionResult = [ByteSource | null, IOResult, ExecutionNode]

export type ExecuteFn = (
  command: string,
  opts: { sessionId: string; session?: Session; signal?: AbortSignal; stdin?: ByteSource | null },
) => Promise<IOResult>

export interface ExecuteNodeDeps {
  dispatch: DispatchFn
  registry: MountRegistry
  namespace: Namespace
  jobTable: JobTable
  executeFn: ExecuteFn
  agentId: string
  workspaceId: string
  registerCloser: (fn: () => Promise<void>) => void
  ensureOpen?: (resource: Resource) => Promise<void>
  runtimeBindings?: Record<string, Runtime>
  routingDecision?: PolicyDecision
  signal?: AbortSignal
  /**
   * Parse one line into a tree. Only alias expansion needs it: an alias
   * rewrites the head word textually and the result is read as a fresh
   * line, so a value holding a pipe is a pipe. Absent (a unit test
   * driving the walker directly) means an alias definition is stored and
   * printed but never expanded.
   */
  reparse?: (line: string) => TSNodeLike
  /**
   * Console this node writes its output to as it is produced.
   * When set, the node emits and returns no stdout; when unset
   * it returns stdout as a value, which is what capture sites
   * (command substitution, pipe stages, redirects) rely on.
   */
  sink?: JobConsole
}
