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

import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { formatLsLong } from '../utils/formatting.ts'
import { gnuStrerror } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { rebaseOne } from '../../../utils/path.ts'
import { formatRecords } from '../utils/output.ts'

type Readdir = (p: PathSpec) => Promise<string[]>
type Stat = (p: PathSpec) => Promise<FileStat>
type SortBy = 'time' | 'size' | 'name'

interface WalkOpts {
  all: boolean
  sortBy: SortBy
  reverse: boolean
  recursive: boolean
}

// One ls operand once its kind is known. `row` is set when the operand is not
// a directory: GNU prints those first, as one block with no header. `groups`
// holds one [dir, entries] pair per directory listed under the operand — one
// for a plain listing, the whole pre-order subtree under -R. Both empty means
// the operand could not be accessed.
interface Operand {
  readonly path: PathSpec
  readonly row: FileStat | null
  readonly groups: [PathSpec, FileStat[]][]
}

function childSpec(entryPath: string, prefix: string): PathSpec {
  return new PathSpec({
    virtual: entryPath,
    directory: entryPath,
    resolved: false,
    resourcePath: mountKey(entryPath, prefix),
  })
}

function formatShort(s: FileStat, classify: boolean): string {
  const suffix = classify && s.type === FileType.DIRECTORY ? '/' : ''
  return `${s.name}${suffix}`
}

function appendListing(
  stats: readonly FileStat[],
  long: boolean,
  human: boolean,
  classify: boolean,
  lines: string[],
): void {
  if (long) {
    for (const line of formatLsLong(stats, { human })) lines.push(line)
    return
  }
  for (const s of stats) lines.push(formatShort(s, classify))
}

function compareStats(a: FileStat, b: FileStat, sortBy: SortBy): number {
  if (sortBy === 'time') {
    const am = a.modified ?? ''
    const bm = b.modified ?? ''
    return am < bm ? 1 : am > bm ? -1 : 0
  }
  if (sortBy === 'size') return (b.size ?? 0) - (a.size ?? 0)
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function sortStats(stats: readonly FileStat[], sortBy: SortBy, reverse: boolean): FileStat[] {
  const sorted = [...stats].sort((a, b) => compareStats(a, b, sortBy))
  if (reverse) sorted.reverse()
  return sorted
}

function errorMessage(err: unknown): string {
  return (
    gnuStrerror((err as { code?: string }).code) ??
    (err instanceof Error ? err.message : String(err))
  )
}

// A file operand whose readdir came back empty: backends without real
// directories (e.g. S3) list the "<file>/" prefix and find nothing rather than
// raising ENOTDIR. Return the stat only when it is a non-directory, so an empty
// directory still lists as empty. Mirrors Python ls `_file_entry`.
async function fileEntry(stat: Stat, path: PathSpec): Promise<FileStat | null> {
  try {
    const s = await stat(path)
    return s.type !== FileType.DIRECTORY ? asOperand(s, path) : null
  } catch {
    return null
  }
}

// GNU ls prints a file operand as given (`ls sub/x.txt` shows sub/x.txt,
// not x.txt); the row carries the operand spelling. Every other field
// (mode/uid/gid/atime overlay attrs included) is preserved, mirroring the
// Python `s.model_copy(update={"name": ...})`.
function asOperand(s: FileStat, path: PathSpec): FileStat {
  return new FileStat({
    name: path.rawPath,
    size: s.size,
    modified: s.modified,
    fingerprint: s.fingerprint,
    revision: s.revision,
    type: s.type,
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    atime: s.atime,
    extra: s.extra,
  })
}

async function listDir(
  readdir: Readdir,
  stat: Stat,
  dir: PathSpec,
  all: boolean,
): Promise<FileStat[]> {
  const entries = await readdir(dir)
  const stats = await Promise.all(
    entries.map((p) => stat(childSpec(p, mountPrefixOf(dir.virtual, dir.resourcePath)))),
  )
  return all ? stats : stats.filter((s) => !s.name.startsWith('.'))
}

// List one operand and report whether it turned out to be a directory.
async function probeOperand(
  readdir: Readdir,
  stat: Stat,
  path: PathSpec,
  opts: WalkOpts,
  warnings: string[],
): Promise<Operand> {
  let stats: FileStat[]
  try {
    stats = await listDir(readdir, stat, path, opts.all)
  } catch (err) {
    const row = await fileEntry(stat, path)
    if (row !== null) return { path, row, groups: [] }
    warnings.push(`ls: cannot access '${path.rawPath}': ${errorMessage(err)}`)
    return { path, row: null, groups: [] }
  }
  if (stats.length === 0) {
    const row = await fileEntry(stat, path)
    if (row !== null) return { path, row, groups: [] }
  }
  const entries = sortStats(stats, opts.sortBy, opts.reverse)
  const groups: [PathSpec, FileStat[]][] = [[path, entries]]
  if (opts.recursive) {
    for (const s of entries) {
      if (s.type !== FileType.DIRECTORY) continue
      const childPath = `${rstripSlash(path.virtual)}/${s.name}`
      const child = await probeOperand(
        readdir,
        stat,
        childSpec(childPath, mountPrefixOf(path.virtual, path.resourcePath)),
        opts,
        warnings,
      )
      groups.push(...child.groups)
    }
  }
  return { path, row: null, groups }
}

// Sort row for one operand, named with the operand's own spelling.
async function operandKey(operand: Operand, sortBy: SortBy, stat: Stat): Promise<FileStat> {
  if (operand.row !== null) return operand.row
  if (sortBy === 'name') {
    return new FileStat({ name: operand.path.rawPath, type: FileType.DIRECTORY })
  }
  try {
    return asOperand(await stat(operand.path), operand.path)
  } catch {
    // The stat only supplies a sort key; an operand that cannot be statted
    // sorts as if it had none rather than failing the listing.
    return new FileStat({ name: operand.path.rawPath, type: FileType.DIRECTORY })
  }
}

async function sortOperands(
  operands: readonly Operand[],
  sortBy: SortBy,
  reverse: boolean,
  stat: Stat,
): Promise<Operand[]> {
  const keyed: { key: FileStat; operand: Operand }[] = []
  for (const operand of operands) {
    keyed.push({ key: await operandKey(operand, sortBy, stat), operand })
  }
  keyed.sort((a, b) => compareStats(a.key, b.key, sortBy))
  if (reverse) keyed.reverse()
  return keyed.map((k) => k.operand)
}

// Exit 1 only when nothing could be listed at all; directory headers are
// output, not evidence that an operand succeeded.
function finish(lines: string[], warnings: string[], listed: boolean): CommandFnResult {
  const out: ByteSource = formatRecords(lines)
  const exitCode = warnings.length > 0 && !listed ? 1 : 0
  if (warnings.length > 0) {
    return [out, new IOResult({ stderr: formatRecords(warnings), exitCode })]
  }
  return [out, new IOResult({ exitCode })]
}

export async function lsGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  readdir: Readdir,
  stat: Stat,
): Promise<CommandFnResult> {
  const targets: PathSpec[] =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            virtual: opts.cwd,
            directory: opts.cwd,
            resolved: false,
            resourcePath: mountKey(opts.cwd, opts.mountPrefix ?? ''),
          }),
        ]
  const long = opts.flags.args_l === true && opts.flags.args_1 !== true
  const all = opts.flags.a === true || opts.flags.A === true
  const human = opts.flags.h === true
  const reverse = opts.flags.r === true
  const classify = opts.flags.F === true
  const recursive = opts.flags.R === true
  const listDirItself = opts.flags.d === true
  const sortBy: SortBy = opts.flags.t === true ? 'time' : opts.flags.S === true ? 'size' : 'name'
  const warnings: string[] = []
  const lines: string[] = []

  if (listDirItself) {
    // -d turns every operand into a plain row, sorted together and printed
    // with no headers.
    const collected: FileStat[] = []
    for (const p of targets) {
      try {
        // GNU ls -d prints the operand as given.
        collected.push(asOperand(await stat(p), p))
      } catch (err) {
        warnings.push(`ls: cannot access '${p.rawPath}': ${errorMessage(err)}`)
      }
    }
    const rows = collected.length > 1 ? sortStats(collected, sortBy, reverse) : collected
    appendListing(rows, long, human, classify, lines)
    return finish(lines, warnings, rows.length > 0)
  }

  const walkOpts: WalkOpts = { all, sortBy, reverse, recursive }
  const probed: Operand[] = []
  for (const p of targets) {
    probed.push(await probeOperand(readdir, stat, p, walkOpts, warnings))
  }
  const operands = probed.length > 1 ? await sortOperands(probed, sortBy, reverse, stat) : probed

  // GNU names every listed directory once there is more than one operand
  // (or under -R); a lone directory operand is listed bare.
  const headed = recursive || targets.length > 1
  const rows = operands.flatMap((o) => (o.row !== null ? [o.row] : []))
  appendListing(rows, long, human, classify, lines)
  let printed = rows.length > 0
  for (const operand of operands) {
    for (const [dirSpec, entries] of operand.groups) {
      if (headed) {
        if (printed) lines.push('')
        lines.push(`${rebaseOne(dirSpec.virtual, operand.path.virtual, operand.path.rawPath)}:`)
      }
      appendListing(entries, long, human, classify, lines)
      printed = true
    }
  }

  const listed = operands.some((o) => o.row !== null || o.groups.length > 0)
  return finish(lines, warnings, listed)
}
