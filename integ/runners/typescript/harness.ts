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

import { validateConcurrent } from './execution.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// integ/runtime holds the runtime suite (its own schema and runners,
// integ/runtime/run.{py,ts} + cli.sh), not battery cases; keep it out.
const CASE_DIRS = ['unix', 'shell', 'crossmount', 'resources', 'cli', 'session', 'console']
const ENC = new TextEncoder()

import type { Target, ServiceEnv, Case, ExecWorkspace } from './types.ts'
export type * from './types.ts'

export function integRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function loadTargets(root: string): Map<string, Target> {
  const data = JSON.parse(readFileSync(join(root, 'targets.json'), 'utf8')) as {
    targets: Target[]
  }
  return new Map(data.targets.map((t) => [t.id, t]))
}

/**
 * The service -> per-host required env vars table.
 *
 * An empty list means the host needs nothing because its adapter starts an
 * in-process fake; the two hosts differ here (python self-hosts s3, ssh, hf,
 * box, databricks, discord, linear and dify, typescript does not), so the
 * asymmetry is spelled out per host rather than inferred.
 */
export function loadServices(root: string): Map<string, ServiceEnv> {
  const data = JSON.parse(readFileSync(join(root, 'targets.json'), 'utf8')) as {
    services: Record<string, ServiceEnv>
    targets: Target[]
  }
  const named = new Set(data.targets.map((t) => t.service).filter((s) => s !== undefined))
  const declared = new Set(Object.keys(data.services))
  const undeclared = [...named].filter((s) => !declared.has(s)).sort()
  if (undeclared.length) {
    throw new Error(`targets.json: services missing an entry: ${undeclared.join(', ')}`)
  }
  const unused = [...declared].filter((s) => !named.has(s)).sort()
  if (unused.length) {
    throw new Error(`targets.json: services entry names no target: ${unused.join(', ')}`)
  }
  for (const [name, hosts] of Object.entries(data.services)) {
    if (!Array.isArray(hosts.python) || !Array.isArray(hosts.typescript)) {
      throw new Error(`targets.json: service '${name}' must declare both 'python' and 'typescript'`)
    }
  }
  return new Map(Object.entries(data.services))
}

/**
 * Service names a caller declares it knowingly does not provision.
 *
 * Rejects a name that is not a real service so the list cannot rot into a typo
 * that quietly widens what --strict tolerates.
 */
export function parseAllowSkip(services: Map<string, ServiceEnv>, value: string): Set<string> {
  const names = new Set(
    value
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== ''),
  )
  const unknown = [...names].filter((n) => !services.has(n)).sort()
  if (unknown.length) {
    throw new Error(`--allow-skip names unknown service(s): ${unknown.join(', ')}`)
  }
  return names
}

/** Env vars this host needs for this target and does not have. */
export function missingEnv(
  services: Map<string, ServiceEnv>,
  target: Target,
  host: 'python' | 'typescript',
): string[] {
  if (target.service === undefined) return []
  const entry = services.get(target.service)
  if (entry === undefined) throw new Error(`unknown service: ${target.service}`)
  return entry[host].filter((v) => !process.env[v])
}

export function loadCases(root: string, suites: string[] = []): Case[] {
  const selected = new Set(suites.length ? suites : CASE_DIRS)
  const unknown = [...selected].filter((suite) => !CASE_DIRS.includes(suite))
  if (unknown.length) throw new Error(`unknown suites: ${unknown.sort().join(', ')}`)
  const cases: Case[] = []
  for (const name of CASE_DIRS) {
    if (!selected.has(name)) continue
    const dir = join(root, name)
    let files: string[]
    try {
      files = walkFiles(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    } catch {
      continue
    }
    const tables = files.map((file) => {
      const data = JSON.parse(readFileSync(file, 'utf8')) as {
        family?: string
        cases: Case[]
      }
      const family = data.family ?? dirname(relative(root, file))
      if (typeof family !== 'string' || !family)
        throw new Error(`${file}: family must be a nonempty string`)
      return { file, family, cases: data.cases }
    })
    tables.sort((a, b) =>
      a.family < b.family
        ? -1
        : a.family > b.family
          ? 1
          : a.file < b.file
            ? -1
            : a.file > b.file
              ? 1
              : 0,
    )
    for (const { file, cases: entries } of tables) {
      const rel = relative(root, file)
      for (const c of entries) {
        c._source = rel
        cases.push(c)
      }
    }
  }
  cases.sort((a, b) => (a.seq ?? 1 << 30) - (b.seq ?? 1 << 30))
  validateCases(root, cases)
  if (!cases.length) throw new Error('selected suites contain no cases')
  return cases
}

/**
 * Fail loudly on the two ways a case silently stops being tested.
 *
 * A duplicate id collides in the parity runner, which keys rows by
 * (target, id), so one of the pair is dropped from the py/ts diff without a
 * word. A target id that matches no manifest entry means the case never runs
 * anywhere, which reads as "passing" everywhere.
 */
export function validateCases(root: string, cases: Case[]): void {
  const known = new Set(loadTargets(root).keys())
  const seen = new Map<string, string>()
  const duplicates: string[] = []
  const unknown: string[] = []
  for (const c of cases) {
    validateConcurrent(c)
    const first = seen.get(c.id)
    if (first !== undefined) duplicates.push(`${c.id} (${first} and ${c._source ?? '?'})`)
    else seen.set(c.id, c._source ?? '?')
    for (const t of c.targets) {
      if (!known.has(t)) unknown.push(`${c.id} -> ${t} (${c._source ?? '?'})`)
    }
  }
  if (duplicates.length) throw new Error(`duplicate case ids: ${duplicates.join('; ')}`)
  if (unknown.length) {
    throw new Error(`cases naming an unknown target: ${unknown.join('; ')}`)
  }
}

export function walkFiles(base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(base)) {
    const full = join(base, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

/**
 * Where a fixture's files are, building them first if it says to.
 *
 * A fixture holding a `build.sh` generates its own contents into a temporary
 * directory instead of shipping them. Only git needs this so far, and it needs
 * it absolutely: a repository cannot hold another repository's `.git`, because
 * `git add` silently refuses any path with a `.git` component, so a checked-in
 * tree would look staged and never be. Generating also keeps the fixture
 * readable as a script rather than as zlib blobs.
 *
 * The caller owns the temporary directory when one is returned.
 */
export function buildFixture(base: string): [string, string | null] {
  const script = join(base, 'build.sh')
  if (!existsSync(script)) return [base, null]
  const built = mkdtempSync(join(tmpdir(), 'mirage-integ-fixture-'))
  execFileSync('bash', [script, join(built, 'repo')], { stdio: 'ignore' })
  return [join(built, 'repo'), built]
}

export async function seedFixture(
  ws: ExecWorkspace,
  fixture: string | undefined,
  mountPath: string,
  root: string,
): Promise<void> {
  if (!fixture) return
  const [base, built] = buildFixture(join(root, 'fixtures', fixture))
  try {
    await seedFrom(ws, base, mountPath)
  } finally {
    if (built !== null) rmSync(built, { recursive: true, force: true })
  }
}

async function seedFrom(ws: ExecWorkspace, base: string, mountPath: string): Promise<void> {
  for (const file of walkFiles(base)) {
    const rel = relative(base, file).split(sep).join('/')
    const dest = `${mountPath.replace(/\/+$/, '')}/${rel}`
    const parent = dest.slice(0, dest.lastIndexOf('/'))
    await ws.execute(`mkdir -p ${parent}`)
    await ws.execute(`tee ${dest} > /dev/null`, {
      stdin: new Uint8Array(readFileSync(file)),
    })
  }
}

export async function seedMountRoot(ws: ExecWorkspace, mountPath: string): Promise<void> {
  // Prefix-scoped object stores treat an absent prefix as an empty
  // directory, and the gws adapter pre-creates each mount's root folder
  // chain, but folder-backed services (dropbox, sharepoint) 404 when a
  // mount roots at a folder nothing ever created. Writing and removing a
  // marker file rides the same workspace plumbing fixture seeding uses:
  // the upload auto-creates the folder chain and the delete leaves the
  // folders behind, so the mount lists as empty like every other target.
  const marker = `${mountPath.replace(/\/+$/, '')}/.seed`
  await ws.execute(`tee ${marker} > /dev/null`, {
    stdin: ENC.encode('seed\n'),
  })
  await ws.execute(`rm ${marker}`)
}

export { runCase, compare, runScenario, statCheck } from './execution.ts'
import { bindMount as bindCase } from './execution.ts'
export function bindMount(c: Case, mountPath: string): Case {
  return bindCase(c, mountPath, process.env.HTTP_ENDPOINT ?? '')
}

export class Report {
  passed = 0
  failed = 0
  failures: string[] = []

  record(target: string, caseId: string, diffs: string[]): void {
    if (diffs.length) {
      this.failed++
      const joined = diffs.join('; ')
      this.failures.push(`[${target}] ${caseId}: ${joined}`)
      process.stdout.write(`FAIL [${target}] ${caseId}: ${joined}\n`)
    } else {
      this.passed++
      process.stdout.write(`ok   [${target}] ${caseId}\n`)
    }
  }

  summary(): string {
    return `${String(this.passed)} passed, ${String(this.failed)} failed`
  }
}

export { ENC }
