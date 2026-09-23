import git from 'isomorphic-git'
import type { FlagView } from '../../../spec/flag_view.ts'
import { pairRenames, kindOf } from './changes.ts'
import { combinedLines } from './combined.ts'
import { GitError } from './errors.ts'
import type { CommitFacts } from './format.ts'
import { filePatch } from './patch.ts'
import { commitFacts, repoArgs, type Repo } from './repo.ts'
import { similarityScore } from './similarity.ts'
import { diffstat, statTable, type FileStat } from './summary.ts'
import { treeEntries, type TreeEntry } from './tree.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

export interface DiffFlags {
  nameOnly: boolean
  nameStatus: boolean
  stat: boolean
  numstat: boolean
  shortstat: boolean
  summary: boolean
  patch: boolean
  noPatch: boolean
  renames: number | null
  merge: string
  raw: boolean
}

export function parseDiffFlags(
  fl: FlagView,
  defaultPatch = true,
  defaultMerge = 'off',
  porcelain = true,
  defaultRenames = true,
): DiffFlags {
  const nameOnly = fl.asBool('name_only'),
    nameStatus = fl.asBool('name_status'),
    stat = fl.asBool('stat'),
    numstat = fl.asBool('numstat'),
    shortstat = fl.asBool('shortstat'),
    summary = fl.asBool('summary')
  const modes = nameOnly || nameStatus || stat || numstat || shortstat || summary
  const rename = fl.raw('find_renames')
  let threshold: number | null = porcelain && defaultRenames ? 50 : null
  if (rename !== undefined && rename !== false) {
    threshold = 50
    if (typeof rename === 'string' && rename !== '') {
      threshold = rename.endsWith('%')
        ? Number(rename.slice(0, -1))
        : Math.floor(Number(`0.${rename}`) * 100)
      if (!Number.isFinite(threshold)) throw new GitError(`invalid similarity index ${rename}`)
    }
  }
  if (fl.asBool('no_renames')) threshold = null
  let merge = fl.asStr('diff_merges') ?? defaultMerge
  if (fl.asBool('m')) merge = 'separate'
  if (fl.asBool('c')) merge = 'combined'
  if (fl.asBool('cc')) merge = 'dense-combined'
  if (porcelain && fl.asBool('first_parent')) merge = 'first-parent'
  const aliases: Record<string, string> = {
    '0': 'off',
    '1': 'separate',
    on: 'separate',
    m: 'separate',
    c: 'combined',
    cc: 'dense-combined',
  }
  merge = aliases[merge] ?? merge
  if (!['off', 'separate', 'combined', 'dense-combined', 'first-parent'].includes(merge))
    throw new GitError(`invalid value for --diff-merges: ${merge}`)
  const patch =
    fl.asBool('patch') ||
    ((defaultPatch || fl.asBool('cc') || (porcelain && fl.asBool('c'))) && !modes)
  return {
    nameOnly,
    nameStatus,
    stat,
    numstat,
    shortstat,
    summary,
    patch,
    noPatch: fl.asBool('no_patch'),
    renames: threshold,
    merge,
    raw: !defaultPatch && !modes && !patch,
  }
}

interface Change {
  path: string
  oldPath: string
  old: TreeEntry | null
  new: TreeEntry | null
  status: string
  score: number
}

function equal(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  return a?.oid === b?.oid && a?.mode === b?.mode
}

async function compare(
  repo: Repo,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  threshold: number | null,
): Promise<Change[]> {
  const codes = new Map<string, string>(),
    oids = new Map<string, string>(),
    kinds = new Map<string, string>()
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(compareCodePoints)) {
    const a = before.get(path),
      b = after.get(path)
    if (equal(a, b)) continue
    codes.set(path, !a ? 'A' : !b ? 'D' : a.mode.slice(0, 3) !== b.mode.slice(0, 3) ? 'T' : 'M')
    const entry = b ?? a
    if (entry) {
      oids.set(path, entry.oid)
      kinds.set(path, kindOf(entry.mode))
    }
  }
  const pairs =
    threshold === null
      ? new Map([...codes].map(([p, c]) => [p, [c, null] as const]))
      : await pairRenames(repo, codes, oids, kinds, threshold)
  const rows: Change[] = []
  for (const [path, [status, origin]] of [...pairs].sort((a, b) => compareCodePoints(a[0], b[0]))) {
    const oldPath = origin ?? path,
      old = before.get(oldPath) ?? null,
      now = after.get(path) ?? null
    const score =
      origin !== null && old && now
        ? old.oid === now.oid
          ? 100
          : similarityScore(await blobData(repo, old), await blobData(repo, now))
        : 0
    rows.push({ path, oldPath, old, new: now, status, score })
  }
  return rows
}

function renameName(old: string, fresh: string): string {
  const a = old.split('/'),
    b = fresh.split('/'),
    prefix: string[] = [],
    suffix: string[] = []
  while (a.length > 1 && b.length > 1 && a[0] === b[0]) {
    prefix.push(a.shift() ?? '')
    b.shift()
  }
  while (a.length > 1 && b.length > 1 && a.at(-1) === b.at(-1)) {
    suffix.unshift(a.pop() ?? '')
    b.pop()
  }
  const middle = `${a.join('/')} => ${b.join('/')}`
  return prefix.length || suffix.length ? [...prefix, `{${middle}}`, ...suffix].join('/') : middle
}

async function blobData(repo: Repo, entry: TreeEntry | null): Promise<Uint8Array> {
  if (!entry) return new Uint8Array()
  if (entry.mode === '160000') return new TextEncoder().encode(`Subproject commit ${entry.oid}\n`)
  return (await git.readBlob({ ...repoArgs(repo), oid: entry.oid })).blob
}
function lines(data: Uint8Array): string[] {
  const text = new TextDecoder().decode(data)
  return text === '' ? [] : text.split(/(?<=\n)/)
}

async function renderChanges(repo: Repo, rows: Change[], flags: DiffFlags): Promise<string> {
  if (flags.noPatch) return ''
  let output: string[] = []
  const numbers: string[] = [],
    summaries: string[] = []
  const stats: FileStat[] = [],
    patches: string[] = []
  for (const row of rows) {
    const status = row.status === 'R' ? `R${String(row.score).padStart(3, '0')}` : row.status
    const paths = row.status === 'R' ? `${row.oldPath}\t${row.path}` : row.path
    if (flags.nameOnly) output.push(row.path)
    else if (flags.nameStatus) output.push(`${status}\t${paths}`)
    else if (flags.raw)
      output.push(
        `:${row.old?.mode ?? '000000'} ${row.new?.mode ?? '000000'} ${row.old?.oid ?? '0'.repeat(40)} ${row.new?.oid ?? '0'.repeat(40)} ${status}\t${paths}`,
      )
    else {
      const before = new Map(row.old ? [[row.path, row.old]] : []),
        after = new Map(row.new ? [[row.path, row.new]] : [])
      const counted = await diffstat(repo, before, after)
      const display = row.status === 'R' ? renameName(row.oldPath, row.path) : row.path
      let stat = counted[0]
      if (!stat) {
        const fresh = (await diffstat(repo, new Map(), after))[0]
        if (!fresh) throw new Error('Missing renamed entry')
        stat = { ...fresh, insertions: 0, deletions: 0, oldSize: fresh.newSize }
      }
      stat = { ...stat, path: display }
      stats.push(stat)
      if (flags.numstat)
        numbers.push(
          `${stat.binary ? '-\t-' : `${String(stat.insertions)}\t${String(stat.deletions)}`}\t${display}`,
        )
      if (flags.summary) {
        if (row.status === 'R') summaries.push(` rename ${display} (${String(row.score)}%)`)
        else if (!row.old && row.new) summaries.push(` create mode ${row.new.mode} ${row.path}`)
        else if (!row.new && row.old) summaries.push(` delete mode ${row.old.mode} ${row.path}`)
        else if (row.old && row.new && row.old.mode !== row.new.mode)
          summaries.push(` mode change ${row.old.mode} => ${row.new.mode} ${row.path}`)
      }
      if (flags.patch)
        patches.push(
          await filePatch(
            repo,
            row.path,
            row.oldPath,
            row.old,
            row.new,
            row.status === 'R' ? row.score : null,
          ),
        )
    }
  }
  if (!(flags.nameOnly || flags.nameStatus || flags.raw)) {
    const table = statTable(stats)
    output = [
      ...numbers,
      ...(flags.stat ? table : flags.shortstat ? table.slice(-1) : []),
      ...summaries,
    ]
  }
  return (
    output.map((l) => l + '\n').join('') +
    (output.length && patches.length ? '\n' : '') +
    patches.join('')
  )
}

async function entries(
  repo: Repo,
  tree: string | null,
  recursive: boolean,
): Promise<Map<string, TreeEntry>> {
  if (tree === null) return new Map()
  if (recursive) return treeEntries(repo, tree)
  const { tree: items } = await git.readTree({ ...repoArgs(repo), oid: tree })
  return new Map(items.map((e) => [e.path, { mode: e.mode, oid: e.oid }]))
}

export async function treeOutput(
  repo: Repo,
  before: string | null,
  after: string,
  flags: DiffFlags,
  recursive = true,
): Promise<string> {
  return renderChanges(
    repo,
    await compare(
      repo,
      await entries(repo, before, recursive),
      await entries(repo, after, recursive),
      flags.renames,
    ),
    flags,
  )
}

export async function commitOutput(
  repo: Repo,
  commit: CommitFacts,
  flags: DiffFlags,
  recursive = true,
  root = true,
): Promise<string[]> {
  const trees: string[] = []
  for (const p of commit.parents) trees.push((await commitFacts(repo, p)).tree)
  if (!trees.length)
    return root ? [await treeOutput(repo, null, commit.tree, flags, recursive)] : []
  if (trees.length === 1 || flags.merge === 'first-parent')
    return [await treeOutput(repo, trees[0] ?? null, commit.tree, flags, recursive)]
  if (flags.merge === 'off') return []
  if (flags.merge === 'separate') {
    const out: string[] = []
    for (const tree of trees) out.push(await treeOutput(repo, tree, commit.tree, flags, recursive))
    return out
  }
  const after = await entries(repo, commit.tree, recursive),
    comparisons: Change[][] = []
  for (const tree of trees)
    comparisons.push(
      await compare(repo, await entries(repo, tree, recursive), after, flags.renames),
    )
  const maps = comparisons.map((rows) => new Map(rows.map((row) => [row.path, row])))
  const common = [...(maps[0]?.keys() ?? [])]
    .filter((path) => maps.every((m) => m.has(path)))
    .sort(compareCodePoints)
  if (flags.noPatch) return []
  if (flags.nameOnly || flags.nameStatus || flags.raw)
    return [
      common
        .map((path) => {
          const rows = maps.map((m) => changeAt(m, path)),
            status = rows.map((r) => r.status).join('')
          if (flags.nameOnly) return path + '\n'
          if (flags.nameStatus) return `${status}\t${path}\n`
          const all = [...rows.map((r) => r.old), rows[0]?.new ?? null]
          return (
            ':'.repeat(maps.length) +
            all.map((e) => e?.mode ?? '000000').join(' ') +
            ' ' +
            all.map((e) => e?.oid ?? '0'.repeat(40)).join(' ') +
            ` ${status}\t${path}\n`
          )
        })
        .join(''),
    ]
  const stat =
    flags.stat || flags.numstat || flags.shortstat || flags.summary
      ? await renderChanges(repo, comparisons[0] ?? [], { ...flags, patch: false })
      : ''
  const body = flags.patch
    ? await combinedPatch(repo, maps, common, flags.merge === 'dense-combined')
    : ''
  return [stat + (stat && body ? '\n' : '') + body]
}

async function combinedPatch(
  repo: Repo,
  maps: Map<string, Change>[],
  paths: string[],
  dense: boolean,
): Promise<string> {
  const output: string[] = []
  for (const path of paths) {
    const rows = maps.map((m) => changeAt(m, path)),
      fresh = rows[0]?.new ?? null,
      old = rows.map((r) => r.old)
    const data = await blobData(repo, fresh),
      parents: Uint8Array[] = []
    for (const entry of old) parents.push(await blobData(repo, entry))
    const body = combinedLines(parents.map(lines), lines(data), dense)
    output.push(`diff --${dense ? 'cc' : 'combined'} ${path}\n`)
    output.push(
      'index ' +
        old.map((e) => (e?.oid ?? '0000000').slice(0, 7)).join(',') +
        '..' +
        (fresh?.oid ?? '0000000').slice(0, 7) +
        '\n',
    )
    if (old.some((e) => !e || e.mode !== fresh?.mode))
      output.push(
        'mode ' +
          old.map((e) => e?.mode ?? '000000').join(',') +
          '..' +
          (fresh?.mode ?? '000000') +
          '\n',
      )
    if ([...parents, data].some((d) => d.subarray(0, 8000).includes(0)))
      output.push('Binary files differ\n')
    else if (body.length) output.push(`--- a/${path}\n`, `+++ b/${path}\n`, ...body)
  }
  return output.join('')
}

function changeAt(rows: ReadonlyMap<string, Change>, path: string): Change {
  const row = rows.get(path)
  if (!row) throw new Error(`Missing combined-diff entry: ${path}`)
  return row
}

export async function renamesEnabled(repo: Repo): Promise<boolean> {
  const value = (await git.getConfig({ ...repoArgs(repo), path: 'diff.renames' })) as
    | string
    | boolean
    | undefined
  return (
    value === undefined || !['false', 'no', 'off', '0', ''].includes(String(value).toLowerCase())
  )
}

export function joinOutput(
  commit: CommitFacts,
  head: string,
  bodies: string[],
  kind: string,
  width: number,
  emptySummary = false,
): string {
  if (!bodies.length) return head
  const blocks = bodies.map((body, index) => {
    let text = head
    if (bodies.length > 1 && !['format', 'tformat'].includes(kind)) {
      const length = kind === 'oneline' ? width : 40
      const id = commit.oid.slice(0, length),
        parent = (commit.parents[index] ?? '').slice(0, length)
      text = text.replace(id, `${id} (from ${parent})`)
    }
    let gap = text && body && kind !== 'oneline' ? '\n' : ''
    if (!body && text && emptySummary) gap = '\n'
    return text + gap + body
  })
  const separator = ['format', 'tformat', 'oneline'].includes(kind) ? '' : '\n'
  return blocks.join(separator)
}
