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

import type { FileStat, PathSpec } from '../../types.ts'
import { FileType } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { fsStrerror } from '../../utils/errors.ts'
import { gnuBasename } from '../../utils/path.ts'
import { getExtension } from '../resolve.ts'
import { BINARY_EXTENSIONS } from './constants.ts'
import { compilePattern } from './grep_pattern.ts'
import { grepContextLines } from './grep_context.ts'
import { decodeLine, lineOffsets, MatchOffsets, prefixOf, rgPieces } from './grep_offsets.ts'
import type { IOResult } from '../../io/types.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { splitLines } from './utils/lines.ts'
import type { AsyncReadBytesFn, AsyncReaddirFn, AsyncStatFn } from './utils/types.ts'

const TYPE_EXTENSIONS: Record<string, string[]> = {
  py: ['.py'],
  js: ['.js', '.jsx'],
  ts: ['.ts', '.tsx'],
  java: ['.java'],
  go: ['.go'],
  rs: ['.rs'],
  rb: ['.rb'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.hpp', '.cc', '.cxx'],
  css: ['.css'],
  html: ['.html', '.htm'],
  json: ['.json'],
  yaml: ['.yaml', '.yml'],
  toml: ['.toml'],
  md: ['.md'],
  txt: ['.txt'],
  xml: ['.xml'],
  sql: ['.sql'],
  sh: ['.sh', '.bash'],
  csv: ['.csv'],
}

function rgMatchesFilter(
  entry: string,
  fileType: string | null,
  globPattern: string | null,
  hidden: boolean,
): boolean {
  const base = gnuBasename(entry)
  if (!hidden && base.startsWith('.')) return false
  if (fileType !== null) {
    const exts = TYPE_EXTENSIONS[fileType] ?? [`.${fileType}`]
    if (!exts.some((ext) => entry.endsWith(ext))) return false
  }
  if (globPattern !== null && !fnmatch(base, globPattern)) return false
  return true
}

/**
 * The candidates a walk of `scopes` would have searched. A search push-down
 * narrows a directory search to candidate files and hands them on as operands
 * of their own, which ripgrep never filters, so the walk's filters are applied
 * here instead: no dot segment below the candidate's (longest-matching) scope
 * unless --hidden, since the walk never descends into a hidden directory, and
 * --type and --glob on the file itself.
 */
export function walkCandidates(
  candidates: PathSpec[],
  scopes: readonly PathSpec[],
  fileType: string | null,
  globPattern: string | null,
  hidden: boolean,
): PathSpec[] {
  const kept: PathSpec[] = []
  for (const p of candidates) {
    let rel = p.virtual
    let best = -1
    for (const scope of scopes) {
      const base = scope.virtual.replace(/\/+$/, '')
      if (base.length > best && (p.virtual === base || p.virtual.startsWith(base + '/'))) {
        rel = p.virtual.slice(base.length)
        best = base.length
      }
    }
    const segments = rel.split('/').filter((s) => s !== '')
    if (!hidden && segments.some((s) => s.startsWith('.'))) continue
    if (!rgMatchesFilter(p.virtual, fileType, globPattern, true)) continue
    kept.push(p)
  }
  return kept
}

export interface RgFullOptions {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  fixedString: boolean
  onlyMatching: boolean
  maxCount: number | null
  wholeWord: boolean
  contextBefore: number
  contextAfter: number
  fileType: string | null
  globPattern: string | null
  hidden: boolean
  noFilename?: boolean
  // -b: prefix each printed line with the byte offset of its own start, or of
  // the match itself under -o.
  byteOffsets?: boolean
  // --files-without-match: answer with the paths that selected NO line. -c
  // outranks it, as it does in ripgrep (`rg --files-without-match -c`
  // prints counts).
  filesWithoutMatch?: boolean
}

// Whether the output shows -A/-B/-C context. Only printed lines carry it: -c,
// -l and --files-without-match answer per file. -o keeps it, each line printed
// as its matches.
function printsContext(opts: RgFullOptions): boolean {
  return (
    (opts.contextBefore > 0 || opts.contextAfter > 0) &&
    !opts.countOnly &&
    !opts.filesOnly &&
    opts.filesWithoutMatch !== true
  )
}

/**
 * Search one already-read file. `io`, when given, receives exit status 0 as
 * soon as a line is selected, so no caller reads the status off the returned
 * list.
 */
function searchFile(
  path: string,
  data: string[],
  compiled: RegExp,
  opts: RgFullOptions,
  prefixPath: string | null,
  io: IOResult | null = null,
): string[] {
  if (opts.maxCount === 0) {
    // ripgrep and GNU both select no line at all under -m0 and print
    // nothing, count included; read before the scan because `count >= 0` is
    // already true at the bottom of the loop.
    return []
  }
  const count = { n: 0 }
  const byteOffsets = opts.byteOffsets === true
  const withoutMatch = opts.filesWithoutMatch === true && !opts.countOnly
  if (printsContext(opts)) {
    // Context rides the shared renderer: match lines `N:`, context lines
    // `N-`, `--` between groups, all led by the label when the search prints
    // one, and a trailing line that would be selected past -m printed as
    // selected, as ripgrep prints it.
    const rendered = grepContextLines(
      data,
      compiled,
      opts.invert,
      opts.lineNumbers,
      opts.maxCount,
      opts.contextAfter,
      opts.contextBefore,
      byteOffsets,
      prefixPath,
      true,
      opts.onlyMatching,
    )
    if (rendered.length > 0 && io !== null) io.exitCode = 0
    // `decodeLine` because the renderer puts a smuggled byte back as itself,
    // and `formatRecords` puts it out as itself too.
    return rendered.map((chunk) => decodeLine(chunk).replace(/\n$/, ''))
  }
  const offsets = byteOffsets ? lineOffsets(data) : []
  // -o -c counts matches, not the lines that hold them (ripgrep 14.1.1).
  let matches = 0
  const results: string[] = []
  for (let i = 0; i < data.length; i++) {
    const line = data[i] ?? ''
    const found = compiled.test(line)
    compiled.lastIndex = 0
    const matched = found !== opts.invert
    if (!matched) continue
    count.n += 1
    if (io !== null) io.exitCode = 0
    const start = byteOffsets ? (offsets[i] ?? 0) : 0
    // -l answers with the path, and the path is the whole output, so it is
    // never dropped for want of a label: a single unlabelled operand used to
    // answer with an empty line here where the python twin answered with the
    // file.
    if (opts.filesOnly) return [prefixPath ?? path]
    if (withoutMatch) return []
    const lineNo = i + 1
    if (opts.onlyMatching) {
      // ripgrep's -o prints each match, an empty one included, and a line
      // with none (an inverted selection) whole; see rgPieces.
      const pieces = rgPieces(compiled, line)
      if (!opts.invert) matches += pieces.length
      const pieceOffsets = byteOffsets ? new MatchOffsets(start, line) : null
      for (const [at, text] of pieces) {
        const only = prefixOf(opts.lineNumbers ? lineNo : null, pieceOffsets?.at(at) ?? null) + text
        results.push(prefixPath !== null ? `${prefixPath}:${only}` : only)
      }
    } else {
      const out = prefixOf(opts.lineNumbers ? lineNo : null, byteOffsets ? start : null) + line
      results.push(prefixPath !== null ? `${prefixPath}:${out}` : out)
    }
    if (opts.maxCount !== null && count.n >= opts.maxCount) break
  }
  if (opts.countOnly) {
    if (count.n === 0) return []
    const shown = String(opts.onlyMatching ? matches : count.n)
    return prefixPath !== null ? [`${prefixPath}:${shown}`] : [shown]
  }
  if (withoutMatch) return [path]
  return results
}

export async function rgFull(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  readBytesFn: AsyncReadBytesFn,
  path: string,
  pattern: string,
  opts: RgFullOptions,
  warnings: string[] | null,
  filePrefix: string | null = null,
  io: IOResult | null = null,
): Promise<string[]> {
  const compiled = compilePattern(pattern, opts.ignoreCase, opts.fixedString, opts.wholeWord)

  let isDir = false
  let startType: FileType | null = null
  try {
    const s = await statFn(path)
    startType = s.type
    isDir = s.type === FileType.DIRECTORY
  } catch {
    try {
      await readdirFn(path)
      isDir = true
    } catch {
      // not readable
    }
  }

  if (!isDir) {
    if (startType === FileType.CHAR_DEVICE) return []
    // ripgrep searches a file named on the line whatever --type, --glob or a
    // leading dot say: its walker filters no entry at depth 0. A push-down
    // that narrows a walk filters its candidates itself (walkCandidates).
    let data: string[]
    try {
      data = splitLines(decodeLine(await readBytesFn(path)))
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${path}: ${fsStrerror(err) ?? String(err)}`)
      return []
    }
    return searchFile(path, data, compiled, opts, filePrefix, io)
  }

  // ripgrep puts `--` between one file's context and the next file's,
  // labelled or not.
  const context = printsContext(opts)
  const results: string[] = []
  let entries: string[]
  try {
    entries = await readdirFn(path)
  } catch (err) {
    if (warnings !== null) warnings.push(`rg: ${path}: ${fsStrerror(err) ?? String(err)}`)
    return results
  }

  for (const entry of entries) {
    let s: FileStat
    try {
      s = await statFn(entry)
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${fsStrerror(err) ?? String(err)}`)
      continue
    }

    if (s.type === FileType.DIRECTORY) {
      // box/dropbox readdir marks folders with a trailing slash; strip it so
      // basename sees the real directory name (hidden-dir skip).
      const child = rstripSlash(entry)
      const base = gnuBasename(child)
      if (!opts.hidden && base.startsWith('.')) continue
      const sub = await rgFull(
        readdirFn,
        statFn,
        readBytesFn,
        child,
        pattern,
        opts,
        warnings,
        null,
        io,
      )
      if (context && results.length > 0 && sub.length > 0) results.push('--')
      results.push(...sub)
      continue
    }
    if (s.type === FileType.CHAR_DEVICE) continue

    if (BINARY_EXTENSIONS.has(getExtension(entry) ?? '')) continue
    if (!rgMatchesFilter(entry, opts.fileType, opts.globPattern, opts.hidden)) continue

    let data: string[]
    try {
      data = splitLines(decodeLine(await readBytesFn(entry)))
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${fsStrerror(err) ?? String(err)}`)
      continue
    }
    // ripgrep -I drops per-file labels in directory walks; -l keeps
    // paths (they are the output).
    const walkPrefix = opts.noFilename === true && !opts.filesOnly ? null : entry
    const fileResults = searchFile(entry, data, compiled, opts, walkPrefix, io)
    if (context && results.length > 0 && fileResults.length > 0) results.push('--')
    results.push(...fileResults)
  }

  return results
}
