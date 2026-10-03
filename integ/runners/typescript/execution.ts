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

import type {
  ExecutionCase,
  ExecWorkspace,
  ScenarioStep,
  HarnessStat,
  StatCheck,
  ProvisionInfo,
  ProvisionExec,
} from './types.ts'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

export async function runScenario(
  ws: ExecWorkspace,
  mutate: (path: string, content: Uint8Array) => Promise<void>,
  steps: ScenarioStep[],
): Promise<{ exitCode: number; out: string }> {
  const outputs: string[] = []
  let exitCode = 0
  for (const step of steps) {
    if ('mutate' in step) {
      await mutate(step.mutate.path, ENC.encode(step.mutate.content))
      continue
    }
    const result = await ws.execute(step.command)
    outputs.push(DEC.decode(result.stdout))
    exitCode = result.exitCode
  }
  return { exitCode, out: outputs.join('') }
}

function checkField(st: HarnessStat, name: string): string {
  let value: string
  if (name === 'mode') {
    value = st.mode !== null ? st.mode.toString(8) : '-'
  } else if (name === 'uid') {
    value = st.uid !== null ? String(st.uid) : '-'
  } else if (name === 'gid') {
    value = st.gid !== null ? String(st.gid) : '-'
  } else {
    // First 19 chars ("2026-01-02T15:30:00") so the Z vs +00:00 suffix
    // never reaches the comparison.
    value = st.modified !== null && st.modified !== '' ? st.modified.slice(0, 19) : '-'
  }
  return `${name}=${value}`
}

/**
 * The probe a case runs beside its command, as one printable line.
 *
 * Two forms. `stat` names a path and the FileStat fields to print. `read`
 * names a path and a byte window, and prints what that window returned: no
 * shell command asks for one, because commands read whole files, so the
 * ranged read op is only reachable through the same door FUSE and the ops
 * facade use.
 */
export async function statCheck(ws: ExecWorkspace, check: StatCheck): Promise<string> {
  if (check.read !== undefined) {
    const data = (await ws.dispatch('read', check.read, [], {
      offset: check.offset ?? 0,
      size: check.size ?? null,
    })) as Uint8Array
    return new TextDecoder().decode(data)
  }
  let st: HarnessStat
  try {
    st = (await ws.dispatch('stat', check.stat ?? '')) as HarnessStat
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 'absent\n'
    throw err
  }
  return (check.fields ?? []).map((name) => checkField(st, name)).join(' ') + '\n'
}

function provisionLine(r: ProvisionInfo): string {
  return (
    `net=${r.networkRead} write=${r.networkWrite} ` +
    `cache=${r.cacheRead} ops=${String(r.readOps)} ` +
    `hits=${String(r.cacheHits)} precision=${r.precision}`
  )
}

/**
 * Substitute {mount} in a case with a target's primary mount path.
 *
 * Lets one case assert a behavior that every backend shares while each target
 * keeps its own mount path. Cases without the token are returned untouched, so
 * this is inert for the existing suite.
 */
// {mount} lets one case assert a behavior every backend shares while each
// target keeps its own mount path. {http} carries the fixture HTTP server's
// base URL, which is only known once the server has bound a port.
export function bindMount<T extends ExecutionCase>(c: T, mountPath: string, http = ''): T {
  const tokens: ReadonlyArray<readonly [string, string]> = [
    ['{mount}', mountPath.replace(/\/+$/, '')],
    ['{http}', http],
  ]
  const subst = (text: string): string =>
    tokens.reduce((acc, [token, value]) => acc.split(token).join(value), text)
  const present = tokens.some(
    ([token]) =>
      c.command?.includes(token) === true ||
      c.expect.stdout.includes(token) ||
      c.expect.stderr.includes(token) ||
      c.check?.stat?.includes(token) === true ||
      c.check?.read?.includes(token) === true ||
      c.expect.check?.includes(token) === true,
  )
  if (!present && c.setup === undefined && c.concurrent === undefined && c.cwd === undefined)
    return c
  const check =
    c.check === undefined
      ? undefined
      : {
          ...c.check,
          ...(c.check.stat !== undefined ? { stat: subst(c.check.stat) } : {}),
          ...(c.check.read !== undefined ? { read: subst(c.check.read) } : {}),
        }
  return {
    ...c,
    ...(c.setup !== undefined ? { setup: subst(c.setup) } : {}),
    ...(c.cwd !== undefined ? { cwd: subst(c.cwd) } : {}),
    ...(c.concurrent !== undefined
      ? {
          concurrent: c.concurrent.map((step) => bindMount(step, mountPath, http)),
        }
      : {}),
    ...(c.command !== undefined ? { command: subst(c.command) } : {}),
    ...(check !== undefined ? { check } : {}),
    expect: {
      ...c.expect,
      stdout: subst(c.expect.stdout),
      stderr: subst(c.expect.stderr),
      ...(c.expect.check !== undefined ? { check: subst(c.expect.check) } : {}),
    },
  }
}

/**
 * Run one case and return what it produced.
 *
 * The post-condition a case declares under `check` is returned beside stdout
 * rather than in place of it, so a case can pin both what the command printed
 * and what it left behind.
 */
export async function runCase(
  ws: ExecWorkspace,
  c: ExecutionCase,
  signal?: AbortSignal,
): Promise<{
  exitCode: number
  out: string
  err: string
  elapsed: number
  checkOut: string | null
}> {
  if (c.clear_cache === true) {
    // A full clear means the file cache AND every mount's index cache:
    // remote listings live in the per-resource index, and a listing
    // populated by an earlier case must not leak into this one. Resources
    // without an index cache (e.g. opfs) have nothing to clear.
    await ws.cache.clear()
    for (const m of ws.mounts()) await m.resource.index?.clear()
  }
  const start = performance.now()
  if (c.provision === true) {
    const plan = await (ws as unknown as ProvisionExec).execute(c.command, {
      provision: true,
    })
    return {
      exitCode: 0,
      out: provisionLine(plan) + '\n',
      err: '',
      elapsed: (performance.now() - start) / 1000,
      checkOut: null,
    }
  }
  if (c.setup !== undefined) {
    const setup = await ws.execute(c.setup, { signal })
    if (setup.exitCode !== 0)
      return {
        exitCode: setup.exitCode,
        out: DEC.decode(setup.stdout),
        err: DEC.decode(setup.stderr),
        elapsed: 0,
        checkOut: null,
      }
  }
  if (c.concurrent !== undefined) {
    validateConcurrent(c)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), (c.timeout_seconds ?? 10) * 1000)
    const groupSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const tasks = c.concurrent.map((step) => runCase(ws, step, groupSignal))
    try {
      const results = await Promise.all(tasks)
      const errors = results.flatMap((result, index) =>
        compare(
          c.concurrent![index]!,
          result.exitCode,
          result.out,
          result.err,
          result.elapsed,
          result.checkOut,
        ).map((diff) => `concurrent[${index}]: ${diff}`),
      )
      if (errors.length)
        return {
          exitCode: 1,
          out: '',
          err: errors.join('\n'),
          elapsed: (performance.now() - start) / 1000,
          checkOut: null,
        }
    } finally {
      clearTimeout(timer)
      controller.abort()
      await Promise.allSettled(tasks)
    }
  }
  const result = await ws.execute(c.command, {
    sessionId: c.session,
    env: c.env,
    cwd: c.cwd,
    signal,
  })
  const elapsed = (performance.now() - start) / 1000
  const out = DEC.decode(result.stdout)
  const checkOut = c.check !== undefined ? await statCheck(ws, c.check) : null
  return {
    exitCode: result.exitCode,
    out,
    err: DEC.decode(result.stderr),
    elapsed,
    checkOut,
  }
}

export function compare(
  c: ExecutionCase,
  exitCode: number,
  out: string,
  err: string,
  elapsed: number,
  checkOut: string | null = null,
): string[] {
  const diffs: string[] = []
  if (exitCode !== c.expect.exit) diffs.push(`exit: expected ${c.expect.exit}, got ${exitCode}`)
  if (out !== c.expect.stdout)
    diffs.push(`stdout: expected ${JSON.stringify(c.expect.stdout)}, got ${JSON.stringify(out)}`)
  if (err.replace(/\n+$/, '') !== c.expect.stderr.replace(/\n+$/, ''))
    diffs.push(`stderr: expected ${JSON.stringify(c.expect.stderr)}, got ${JSON.stringify(err)}`)
  if (c.check !== undefined && checkOut !== c.expect.check)
    diffs.push(`check: expected ${JSON.stringify(c.expect.check)}, got ${JSON.stringify(checkOut)}`)
  const bounds = c.expect.elapsed
  if (bounds !== undefined && (elapsed < bounds.min || elapsed > bounds.max))
    diffs.push(
      `elapsed: expected [${String(bounds.min)}, ${String(bounds.max)}], got ${elapsed.toFixed(3)}`,
    )
  return diffs
}

export function validateConcurrent(c: ExecutionCase): void {
  if (c.concurrent === undefined) return
  if (!Array.isArray(c.concurrent) || c.concurrent.length < 2)
    throw new Error('concurrent requires at least two workers')
  const timeout = c.timeout_seconds ?? 10
  if (typeof timeout !== 'number' || !(timeout > 0 && timeout <= 60))
    throw new Error('concurrent timeout_seconds must be in (0, 60]')
  for (const worker of c.concurrent) {
    if (!worker || typeof worker.command !== 'string')
      throw new Error('concurrent worker requires a command')
    if (
      !worker.expect ||
      !Number.isInteger(worker.expect.exit) ||
      typeof worker.expect.stdout !== 'string' ||
      typeof worker.expect.stderr !== 'string'
    )
      throw new Error('concurrent worker requires exit/stdout/stderr expectations')
    if (['concurrent', 'lifecycle', 'scenario', 'provision'].some((key) => key in worker))
      throw new Error('concurrent worker must be an ordinary shell command')
  }
}
