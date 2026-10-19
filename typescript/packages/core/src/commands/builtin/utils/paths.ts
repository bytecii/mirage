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

import type { LinkView, ReaddirPath, StatPath } from '../../../view/types.ts'
import type { Files } from '../../../workspace/files.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileStat, FileType, LINK_TARGET_KEY, PathSpec, type StatFn } from '../../../types.ts'
import {
  dotWalkError,
  eexist,
  enoent,
  isDotWalkError,
  isMissError,
  isMissingPath,
} from '../../../errors/fs.ts'
import { operandSpelling } from '../../../errors/render.ts'
import { type FsError } from '../../../errors/types.ts'
import { respelled } from '../../../utils/key_prefix.ts'
import {
  CycleError,
  dotLookups,
  dotPrefixes,
  gnuBasename,
  norm,
  parent,
  resolvePath,
} from '../../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { flagOccurrences } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import type { FsCondition } from '../../../errors/types.ts'

/**
 * Opt in by assigning a debug sink, as Python's module logger is off until
 * configured: every failed read runs the probe, and stdout may carry data.
 */
export const logger: { debug?: (message: string) => void } = {}

// What a path is, asked on both channels a backend can answer on.
//
// A point lookup alone cannot decide. On a prefix store a directory is not
// an object, it is the set of keys under it, so stat misses what readdir
// would list. Absence therefore takes *both* channels coming back empty,
// which is the only evidence that nothing is there.
//
// The listing has to be non-empty to count: those stores answer a missing
// path with [] rather than raising, and cannot hold an empty directory
// anyway (one with no keys under it does not exist). Measured across every
// integ target: an implicit directory answers here, a missing path does not.
// That holds only while a backend's readdir refuses a path it cannot prove:
// postgres answered tables/views under any first segment, and every absent
// schema read as a directory here.
//
// A link loop in the path is absence too: the walk reaches nothing there,
// which is the question this answers, and a diagnostic that has to name
// the errno asks missCondition. Mirrors Python's resolve_path_stat.
export async function resolvePathStat(
  dispatch: DispatchFn,
  path: PathSpec,
): Promise<FileStat | null> {
  let stat: FileStat | null = null
  try {
    const [s] = await dispatch('stat', path)
    stat = s as FileStat | null
  } catch (exc) {
    if (!isMissError(exc) && (exc as { code?: string }).code !== 'ELOOP') throw exc
  }
  if (stat !== null) return stat
  let entries: unknown
  try {
    const [raw] = await dispatch('readdir', path)
    entries = raw
  } catch (exc) {
    if (!isMissError(exc) && (exc as { code?: string }).code !== 'ELOOP') throw exc
    return null
  }
  if (!Array.isArray(entries) || entries.length === 0) return null
  return new FileStat({
    name: gnuBasename(rstripSlash(path.virtual)),
    type: FileType.DIRECTORY,
  })
}

// Stat via dispatch in the shape the generics' probes take: destKind and
// its kin are written against a backend stat that raises on a miss, so a
// dispatcher answer of nothing becomes ENOENT. Mirrors Python's
// dispatch_stat.
export function dispatchStat(dispatch: DispatchFn): StatFn {
  return async (path: PathSpec) => {
    const [stat] = await dispatch('stat', path)
    if (stat === null || stat === undefined) throw enoent(path)
    return stat as FileStat
  }
}

function statThrough(files: Files, path: string | PathSpec): Promise<FileStat | null> {
  return resolvePathStat(files.dispatch, PathSpec.fromStrPath(path, undefined, '/'))
}

async function readdirThrough(files: Files, path: string): Promise<string[]> {
  const [entries] = await files.dispatch('readdir', PathSpec.fromStrPath(path, undefined, '/'))
  return entries as string[]
}

// Stat one path through the session's files, null when absent, wherever it
// lives (`find -L` crosses mounts); undefined outside a workspace. Mirrors
// Python's vfs_stat_path.
export function vfsStatPath(files: Files | undefined): StatPath | undefined {
  return files === undefined ? undefined : (path) => statThrough(files, path)
}

// List one directory through the session's files, for a walk that crosses a
// mount; undefined outside a workspace. Mirrors Python's vfs_readdir_path.
export function vfsReaddirPath(files: Files | undefined): ReaddirPath | undefined {
  return files === undefined ? undefined : (path) => readdirThrough(files, path)
}

// A dispatcher lookup in the shape a chain walk reads. StatPath answers
// null for a miss, while dotRefusal and its kin read a stat that throws, so
// a command that holds only the lookup (`vfsStatPath`) wraps it here.
// Mirrors Python's stat_or_enoent.
export function statOrEnoent(statPath: StatPath): StatFn {
  return async (path: PathSpec) => {
    const row = await statPath(path)
    if (row === null) throw enoent(path)
    return row
  }
}

/**
 * `path` keyed by its whole virtual path, the shape a command's paths take:
 * the dispatcher routes each one to its mount, so no command derives a mount
 * from a path's key. Mirrors Python's virtual_key.
 */
export function virtualKey(path: PathSpec): PathSpec {
  return new PathSpec({
    virtual: path.virtual,
    directory: path.directory,
    vfsPath: stripSlash(path.virtual),
    pattern: path.pattern,
    resolved: path.resolved,
    rawPath: path.rawPath,
    dotted: path.dotted,
    walkError: path.walkError,
  })
}

/**
 * A command's flags with every path value keyed by its whole virtual path
 * (`virtualKey`): a single path (awk -f) or a list of them (repeated grep -f).
 * Everything else passes through unchanged. Mirrors Python's virtual_flags.
 */
export function virtualFlags(bag: Record<string, FlagValue>): Record<string, FlagValue> {
  const keyed: Record<string, FlagValue> = { ...bag }
  flagOccurrences(keyed).push(...flagOccurrences(bag))
  for (const [key, value] of Object.entries(bag)) {
    if (value instanceof PathSpec) keyed[key] = virtualKey(value)
    else if (Array.isArray(value))
      keyed[key] = value.map((item) => (item instanceof PathSpec ? virtualKey(item) : item))
  }
  return keyed
}

// `path` spelled from its operand as typed, the way GNU names it. Mirrors
// Python's spelled_from.
export function spelledFrom(path: PathSpec, operand: PathSpec): PathSpec {
  return respelled(path, operandSpelling(path.virtual, operand))
}

// A path at, under or above `root`, spelled the way `root` is. Mirrors
// Python's descendant_path.
export function descendantPath(root: PathSpec, virtual: string): PathSpec {
  return spelledFrom(PathSpec.fromStrPath(virtual), root)
}

// Probe a path once for {exists, isDir}. ENOTDIR counts as "does not exist":
// a path whose parent chain runs through a plain file cannot exist. This is
// the probe for a path that is not an operand (an ancestor in a chain walk,
// an overwrite target already paired); an operand itself goes through
// sourceKind or destKind, which keep the ENOTDIR a slashed spelling earns.
// isMissingPath stays ENOENT-only so read-family commands keep reporting
// "Not a directory" verbatim.
export async function entryKind(
  stat: StatFn,
  path: PathSpec,
): Promise<{ exists: boolean; isDir: boolean }> {
  let info: FileStat
  try {
    info = await stat(path)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (!isMissingPath(err) && code !== 'ENOTDIR') throw err
    return { exists: false, isDir: false }
  }
  return { exists: true, isDir: info.type === FileType.DIRECTORY }
}

// The nearest ancestor of `path` that exists, and whether it is a
// directory. Walked upward from the immediate parent, as the kernel stops
// resolving at the first component it cannot pass. The mount root always
// exists as a directory and is never stat-ed: a backend that cannot stat
// "/" must not fail every operand under it. Mirrors Python's
// nearest_ancestor.
export async function nearestAncestor(stat: StatFn, path: PathSpec): Promise<[string, boolean]> {
  let node = parent(norm(path.virtual))
  while (node !== '/') {
    const { exists, isDir } = await entryKind(stat, descendantPath(path, node))
    if (exists) return [node, isDir]
    node = parent(node)
  }
  return ['/', true]
}

// Whether a path that failed with ENOENT is an implicit directory. Keyed
// backends (RAM/Redis/S3) have no directory entries: stat/read of a prefix
// that only exists through deeper keys raises ENOENT. The operand's own
// readdir cannot serve as the probe: synthetic hierarchies fabricate
// children for any name (postgres answers tables/views for a missing
// schema) and database backends raise driver errors for missing tables.
// The parent listing is authoritative instead: the operand is an implicit
// directory only if its parent's readdir lists it. When the operand is the
// mount root there is no parent to list, so its own readdir decides (root
// listings are real in every backend). A listing that misses is a negative
// probe (the original ENOENT stands); any other failure propagates, as
// Python's MISS_ERRORS catch lets it. Mirrors Python's `is_implicit_dir`.
export async function isImplicitDir(
  readdir: (path: PathSpec) => Promise<string[]>,
  path: PathSpec,
): Promise<boolean> {
  const target = norm(path.virtual)
  const key = stripSlash(path.vfsPath)
  if (!key) {
    try {
      const entries = await readdir(path)
      return entries.length > 0
    } catch (err) {
      if (!isMissError(err) && !isMissingPath(err)) throw err
      return false
    }
  }
  const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  const parentVirtual = parent(target)
  const parentPath = new PathSpec({
    virtual: parentVirtual,
    directory: parentVirtual,
    vfsPath: parentKey,
  })
  try {
    const entries = await readdir(parentPath)
    return entries.some((entry) => norm(entry) === target)
  } catch (err) {
    if (!isMissError(err) && !isMissingPath(err)) throw err
    return false
  }
}

/**
 * Whether a failed or empty read was a read of a directory.
 *
 * Asked after failure or EOF without bytes: some drivers return an empty
 * stream for directories. Nonempty reads need no extra probe. One that knows
 * says so (gdrive, box, dropbox and disk throw EISDIR), a keyed store answers
 * ENOENT because a directory there is a set of keys rather than an object,
 * and sftp answers with an error carrying no errno at all.
 *
 * Three ways the answer can be yes, in probe-cost order. The code itself
 * costs nothing. The stat is one call, and a stat that ANSWERS ends the
 * cascade either way: a file is a file, and the later probe only makes
 * sense for a path stat could not see. Reaching past a successful stat
 * read a rule-refused file as a directory, because its parent's listing
 * names it. The parent listing is one call and is the only thing that can
 * tell a missing key from a prefix that exists only through deeper keys.
 *
 * A no leaves the original error untouched, so nothing is swallowed: the
 * caller rethrows what the backend said. Both probes are broad for that
 * same reason: a probe that fails is a negative probe, never an error to
 * surface. Surfacing one would replace the read's error with one from a
 * call the user never made, and it is the read that failed.
 * `isImplicitDir` narrows to a miss because for its other caller the stat
 * IS the operation; here it is a probe, so the wider catch belongs on this
 * side of the call, and each failure it absorbs is logged. Mirrors Python's
 * `read_hit_a_dir`.
 */
export async function readHitADir(
  stat: (path: PathSpec) => Promise<FileStat>,
  readdir: (path: PathSpec) => Promise<string[]>,
  path: PathSpec,
  err: unknown,
): Promise<boolean> {
  if ((err as { code?: string } | null)?.code === 'EISDIR') return true
  // The path did not resolve at all, which no reading turns into a
  // directory; its parent may well list the name it simplifies to.
  if (isDotWalkError(err)) return false
  let st: FileStat | null = null
  try {
    st = await stat(path)
  } catch (probe) {
    logger.debug?.(`read probe: stat ${path.virtual} failed: ${String(probe)}`)
    // Only a stat that finds nothing leaves room for a directory of deeper
    // keys. One that fails otherwise (an upstream error) proves nothing, and
    // the parent listing would name the file whose backend failed.
    if (!isMissError(probe) && !isMissingPath(probe)) return false
    st = null
  }
  if (st !== null) return st.type === FileType.DIRECTORY
  try {
    if (await isImplicitDir(readdir, path)) return true
  } catch (probe) {
    logger.debug?.(`read probe: listing ${path.virtual} failed: ${String(probe)}`)
  }
  return false
}

// The condition a create at an absent path meets in its parent chain: null
// when the immediate parent is a directory, so the path can be made there;
// ENOTDIR when a plain file stands in the chain; ENOENT when a directory
// higher up is the nearest thing there, the components below it being
// absent. For a caller that already knows `target` is not there, which is
// what destKind finds out first. Mirrors Python's absent_dest_error.
export async function absentDestError(stat: StatFn, target: PathSpec): Promise<FsCondition | null> {
  const [node, isDir] = await nearestAncestor(stat, target)
  if (!isDir) return 'ENOTDIR'
  return node === parent(norm(target.virtual)) ? null : 'ENOENT'
}

// The link resolution a dot walk is handed, null while no link exists.
// Mirrors Python's link_follow.
export function linkFollow(links: LinkView | null | undefined): ((path: string) => string) | null {
  return links === null || links === undefined ? null : (path: string) => links.resolve(path)
}

// One link's target, the hop a canonicalizing walk reads, null while no
// link exists. Mirrors Python's link_target.
export function linkTarget(
  links: LinkView | null | undefined,
): ((path: string) => string | null) | null {
  if (links === null || links === undefined) return null
  return (path: string) => {
    const row = links.statAt(path)
    return row === null ? null : (row.extra[LINK_TARGET_KEY] as string)
  }
}

// Whether `virtual` is the path a dotted spelling names: the textual
// simplification, or that simplification taken through the links. The
// kernel walk (`followPaths`) resolves an operand before its command runs,
// every component or all but the last, and the operand it hands on is still
// the one typed. Mirrors Python's _spells.
function spells(
  dotted: string,
  virtual: string,
  follow: ((path: string) => string) | null,
): boolean {
  const spelled = resolvePath(dotted, '/')
  if (spelled === virtual) return true
  if (follow === null) return false
  const trimmed = rstripSlash(dotted)
  const cut = trimmed.lastIndexOf('/')
  const head = trimmed.slice(0, cut)
  const name = trimmed.slice(cut + 1)
  try {
    const whole = resolvePath(follow(dotted), '/')
    const above = follow(head === '' ? '/' : head)
    return virtual === whole || virtual === resolvePath(`${rstripSlash(above)}/${name}`, '/')
  } catch (err) {
    if (err instanceof CycleError) return false
    throw err
  }
}

/**
 * The typed spelling, links before `..`, while it names the path. Mirrors
 * Python's walk_spelling.
 *
 * Without a trailing slash: that is a final `.`, which `dotRefusal` proves,
 * and a store that keeps no directories reads a slashed key as one, so
 * `cat reg/` there was ENOENT, not ENOTDIR.
 */
export function walkSpelling(path: PathSpec, follow: ((path: string) => string) | null): string {
  const dotted = path.dotted
  if (dotted !== null && spells(dotted, path.virtual, follow)) return rstripSlash(dotted) || '/'
  return path.virtual
}

/**
 * ENOENT when the walk of a path's dots looks up a name the session cannot
 * see, null when it sees every one.
 *
 * `virtual` simplified the dots away, so a hidden name in front of one
 * (`secret/../f`, a hidden link's `lnk/../f`) is gone from the path the
 * hides judge, while the walk still has to find it. It answers as a missing
 * name does, and before `dotRefusal` proves anything a directory, so the
 * refusal cannot tell a hide from an absence. The walk stops at the hidden
 * name, so a link there is never followed. Mirrors Python's hidden_walk.
 */
export function hiddenWalk(
  path: PathSpec,
  follow: ((path: string) => string) | null,
  visible: (path: string) => boolean,
): FsError | null {
  const dotted = path.dotted
  if (dotted === null || !spells(dotted, resolvePath(path.virtual, '/'), follow)) return null
  try {
    for (const looked of dotLookups(dotted, follow)) {
      if (!visible(looked)) return dotWalkError(path, 'ENOENT')
    }
  } catch (err) {
    if (err instanceof CycleError) return dotWalkError(path, 'ELOOP')
    throw err
  }
  return null
}

/**
 * What a path's dot components answer, null when every one resolves.
 *
 * The kernel resolves `.` and `..` against the directory they sit in, so a
 * walk through a missing name fails ENOENT and one through a plain file
 * ENOTDIR (`cat nope/../f`, `cat f.txt/.`), where the textual simplification
 * in `virtual` reached `f` regardless. Each name in front of a dot is proved
 * a directory, in walk order, and one that is not is judged by its chain the
 * way a create is, so a miss under a plain file is ENOTDIR on every store.
 * A link in front of a dot is followed first, as the kernel walks (only
 * bash's `cd` reads `link/..` logically). A trailing slash is a final `.`:
 * an existing name in front of it has to be a directory too (`cat reg/`); a
 * call that creates that name (`creates`: mkdir, symlink) answers EEXIST
 * instead (`mkdir reg/`), however the store keeps the name.
 *
 * Only the path the spelling names is walked: a path derived from it (a
 * child a walker builds, a respelled match) carries the field along but no
 * longer spells it, while the operand the kernel walk followed through a
 * link (`lnk/nope/../f`) still does, which `follow` recognizes. The error
 * names the operand as typed and is a DotWalkError, final for every layer
 * that re-reads a miss. Mirrors Python's dot_refusal.
 */
export async function dotRefusal(
  stat: StatFn,
  path: PathSpec,
  follow: ((path: string) => string) | null = null,
  creates = false,
): Promise<FsError | null> {
  const dotted = path.dotted
  if (dotted === null || !spells(dotted, resolvePath(path.virtual, '/'), follow)) return null
  const proved: string[] = []
  let prefixes: string[]
  try {
    prefixes = dotPrefixes(dotted, follow)
  } catch (err) {
    if (err instanceof CycleError) return dotWalkError(path, 'ELOOP')
    throw err
  }
  for (const prefix of prefixes) {
    if (proved.some((done) => done.startsWith(`${prefix}/`))) continue
    const spec = PathSpec.fromStrPath(prefix)
    const { exists, isDir } = await entryKind(stat, spec)
    if (exists && isDir) {
      proved.push(prefix)
      continue
    }
    if (!exists && (await nearestAncestor(stat, spec))[1]) return dotWalkError(path, 'ENOENT')
    return dotWalkError(path, 'ENOTDIR')
  }
  if (dotted.endsWith('/')) {
    const { exists, isDir } = await entryKind(stat, PathSpec.fromStrPath(path.virtual))
    if (exists && !isDir) return creates ? eexist(path) : dotWalkError(path, 'ENOTDIR')
  }
  return null
}

// Resolve a file a transfer reads or writes (curl -o, wget -O) against the
// session cwd.
export function resolveTarget(o: string | PathSpec, cwd: string): PathSpec {
  return PathSpec.fromStrPath(o, undefined, cwd)
}

// Default a command's path operands the way the shell would: explicit
// operands pass through, otherwise the session cwd becomes the single
// operand. Mirrors Python's default_paths.
export function defaultPaths(paths: PathSpec[], cwd: string): PathSpec[] {
  if (paths.length > 0) return paths
  return [PathSpec.fromStrPath(cwd)]
}
