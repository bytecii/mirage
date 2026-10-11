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

import type { EvalValue, RuntimeIdentity, ScriptSource } from '../types.ts'
import type { NamespaceView, SessionView } from '../../view/types.ts'

/** One command of the line being routed, distilled from the parse. */
export interface ParsedCommand {
  /** Registered command prefix, or the first word when no longer prefix matches. */
  command: string
  words: readonly string[]
  builtin: boolean
  paths: readonly string[]
  /**
   * The installed CLI named by the first word, null otherwise.
   * Lets a policy steer an installed name between the virtual CLI and
   * a runtime capturing the same word.
   */
  cli: string | null
}

/**
 * What a policy may consult about the line, parse-before-policy. `command` /
 * `builtin` name the stage addressed to the consulted party: an entry
 * script sees its runtime's first captured stage (see ctxForRuntime),
 * the global policy sees the line's first command.
 *
 * For `cat /data/logs.txt | python3 process.py` typed in `/data`, the
 * python runtime's script (it captures `python3`) is consulted with:
 *
 * ```
 * ctx.line     === 'cat /data/logs.txt | python3 process.py'
 * ctx.commands === [
 *   { command: 'cat', words: ['cat', '/data/logs.txt'],
 *     builtin: true, paths: ['/data/logs.txt'] },
 *   { command: 'python3', words: ['python3', 'process.py'],
 *     builtin: true, paths: [] },
 * ]
 * ctx.command  === 'python3' // the runtime's first captured stage
 * ctx.builtin  === true
 * ctx.session.cwd() === '/data'
 * ```
 *
 * The global policy script sees the same context with
 * `ctx.command === 'cat'`, the line's first stage. A monty-source
 * script gets this as the `ctx` dict (snake_case `session_id` /
 * `agent_id`, matching Python), with `ctx['runtime']` naming the
 * runtime being asked.
 */
export interface RouteContext {
  line: string
  commands: readonly ParsedCommand[]
  command: string
  builtin: boolean
  sessionId: string
  agentId: string
  /** The session (cwd, env), read only: a write through it is refused. */
  session?: SessionView
  /** The session's namespace. */
  ns?: NamespaceView
}

/**
 * The ctx payload as any evaluator's script sees it.
 *
 * This is the policy context WIRE SCHEMA, a public contract:
 * JSON-shaped (strings, bools, lists, dicts), snake_case keys,
 * identical in both languages, so a script in any evaluator's
 * language (and any transport, in-process or remote) receives the
 * same structure. Keys: line, commands (command/words/builtin/paths/
 * cli per stage), command, builtin, session_id, agent_id, session (cwd,
 * env), mounts (the mount roots under `/` the session may be told
 * about), plus runtime (name/captures) for per-runtime scripts.
 * routeContextFromPayload is the inverse for the line's own fields, so a
 * payload can be stored as JSON and replayed.
 */
export function routeContextPayload(
  ctx: RouteContext,
  runtime?: RuntimeIdentity,
): Record<string, EvalValue> {
  const payload: Record<string, EvalValue> = {
    line: ctx.line,
    commands: ctx.commands.map((c) => ({
      command: c.command,
      words: [...c.words],
      builtin: c.builtin,
      paths: [...c.paths],
      cli: c.cli,
    })),
    command: ctx.command,
    builtin: ctx.builtin,
    session_id: ctx.sessionId,
    agent_id: ctx.agentId,
    session: {
      cwd: ctx.session?.cwd() ?? '',
      env: ctx.session?.snapshot() ?? {},
    },
    mounts: ctx.ns?.mounts?.visibleDescendants('/') ?? [],
  }
  if (runtime !== undefined) {
    payload.runtime = { name: runtime.name, captures: [...runtime.captures] }
  }
  return payload
}

/**
 * Rebuild a context from its wire-schema payload: the inverse of
 * routeContextPayload for the line's own fields (the payload's
 * `session` and `mounts` come from live handles and its `runtime` block
 * from the consultation, so they are ignored), so a stored JSON payload
 * replays through scripts and routes in tests or debugging.
 */
export function routeContextFromPayload(payload: Record<string, unknown>): RouteContext {
  const commands = (payload.commands as Record<string, unknown>[]).map((c) => ({
    command: String(c.command),
    words: (c.words as string[]).slice(),
    builtin: Boolean(c.builtin),
    paths: (c.paths as string[]).slice(),
    cli: typeof c.cli === 'string' ? c.cli : null,
  }))
  return {
    line: String(payload.line),
    commands,
    command: String(payload.command),
    builtin: Boolean(payload.builtin),
    sessionId: String(payload.session_id),
    agentId: String(payload.agent_id),
  }
}

/**
 * A per-runtime willingness script, answering "do I want this line?".
 * In code: a function (sync or async) on the RouteContext returning a
 * truthy verdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * new WorkspaceRuntime({ script: (ctx) => ctx.builtin && !ctx.line.includes('/secret') })
 *
 * // workspace yaml: guard.py next to the config file
 * // runtimes:
 * //   - name: vfs
 * //     script: guard.py
 * ```
 */
export type RouteScript = ((ctx: RouteContext) => boolean | Promise<boolean>) | ScriptSource

/** The affirmative arm: this runtime serves the line. Wire form: `{runtime: name}`. */
export class RouteResult {
  constructor(readonly runtime: string) {}
}

/**
 * The negative arm: refuse the line before anything runs. The line
 * exits 126 with `<command>: Permission denied`, the reason on the result's `refusal` record, on stderr.
 * Wire form: `{deny: reason}`.
 */
export class DenyResult {
  constructor(readonly reason: string) {}
}

/**
 * The typed spelling of a policy verdict, one class per arm.
 *
 * Code policies return an arm instance (or the plain-shape sugar in
 * RouteVerdict); config scripts return the wire dict, since class
 * instances cannot cross the evaluator sandbox. Each arm serializes
 * to one wire key, and future powers grow as fields on the arm they
 * ride (attachments on RouteResult, kubernetes-admission style).
 * Mirrors the python RouteOutcome base class.
 */
type RouteOutcome = RouteResult | DenyResult

/**
 * What the global policy may answer: a RouteOutcome arm, a runtime
 * name, null to pass, or the verdict object (the wire spelling of the
 * arms, the only form a config script can return). Object keys are
 * mutually exclusive: `{runtime: name}` places the line, `{deny:
 * reason}` refuses it. New powers grow as arm fields and wire keys,
 * never as new return types. Mirrors the python RouteVerdict.
 */
type RouteVerdict = RouteOutcome | string | null | { runtime?: string; deny?: string }

/**
 * The global policy, answering "who takes this line?". In code: a
 * function (sync or async) on the RouteContext returning a
 * RouteVerdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * policy: (ctx) => (ctx.command === 'python3' ? 'monty' : null)
 *
 * // workspace yaml: policy.py next to the config file
 * // policy: policy.py
 * ```
 */
export type RoutePolicy =
  | ((ctx: RouteContext) => RouteVerdict | Promise<RouteVerdict>)
  | ScriptSource

/**
 * The one-line placement decision the dispatcher consults.
 *
 * Both fields hold runtimes: the decision IS "which runtime runs which
 * command". The workspace runtime is a legal value in either; a command
 * placed on it is served by the workspace executor itself.
 */
export interface RouteDecision<R extends RuntimeIdentity> {
  /**
   * Every command some entry captures, resolved for this line: the
   * runtime it runs on, or null when its capturers all refused
   * (admission failure, exit 126, never a silent fallback to the
   * workspace).
   */
  bindings: Record<string, R | null>
  /**
   * Where commands no entry captures run: the catch-all workspace runtime,
   * or null when the workspace runtime refused the line or declares
   * captures; unbound commands then exit 126.
   */
  fallback: R | null
}
