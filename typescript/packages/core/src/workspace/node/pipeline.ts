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

import { type ByteSource } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { getRedirects } from '../../shell/syntax/helpers.ts'
import { Redirect, RedirectKind } from '../../shell/types.ts'
import { NodeKind, nodeKind } from '../../shell/syntax/node_kind.ts'
import { expandRedirects } from '../expand/redirects.ts'
import { type ExecuteFn } from '../expand/node.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { sessionView } from '../session/state.ts'
import type { ExecutionResult as Result, ExecuteNodeFn as Recurse } from '../executor/types.ts'

export async function recurseReassociated(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  redirects: readonly Redirect[],
  right: TSNodeLike,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (node !== right) return recurse(node, session, stdin, callStack)
  const [expanded, pipeNode] = await expandRedirects(
    redirects,
    session,
    executeFn,
    registry,
    callStack,
    sessionView(session, registry.policies),
  )
  let [stdout, io, execNode] = await handleRedirect(
    recurse,
    dispatch,
    right,
    expanded,
    session,
    stdin,
    callStack,
  )
  if (pipeNode !== null && stdout !== null) {
    const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
    stdout = stdout2
    io = await io.merge(io2)
    execNode = execNode2
  }
  return [stdout, io, execNode]
}

export async function recursePipeStderr(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  targets: readonly TSNodeLike[],
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (!targets.includes(node) || nodeKind(node) !== NodeKind.REDIRECT) {
    return recurse(node, session, stdin, callStack)
  }
  const [command, redirects] = getRedirects(node)
  redirects.push(new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }))
  const [expanded, pipeNode] = await expandRedirects(
    redirects,
    session,
    executeFn,
    registry,
    callStack,
    sessionView(session, registry.policies),
  )
  let [stdout, io, execNode] = await handleRedirect(
    recurse,
    dispatch,
    command,
    expanded,
    session,
    stdin,
    callStack,
  )
  if (pipeNode !== null && stdout !== null) {
    const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
    stdout = stdout2
    io = await io.merge(io2)
    execNode = execNode2
  }
  return [stdout, io, execNode]
}
