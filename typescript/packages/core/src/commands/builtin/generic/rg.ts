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
import { cacheAwareStream } from '../../../cache/read_through.ts'
import { mountParentReaddir, mountParentStat } from '../utils/operands.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { fsStrerror, isFsError, isWalkError } from '../../../utils/errors.ts'
import { respellRaw } from '../../../utils/path.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { compilePattern, resolvePattern } from '../grep_pattern.ts'
import {
  exitCodeFor,
  grepStream,
  nonzeroCountStream,
  prefixLines,
  type GrepStreamOptions,
} from '../grep_scan.ts'
import { rgFull } from '../rg_scan.ts'
import { decodeLine } from '../grep_offsets.ts'
import { splitLines } from '../utils/lines.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()
// ripgrep's own words for a line with no pattern, exit 2 (14.1.1).
export const RG_NO_PATTERN = 'rg: ripgrep requires at least one pattern to execute a search'
// ripgrep's name for stdin wherever it names the file a line came from.
const STDIN_NAME = '<stdin>'
// The operand ripgrep searches when a line names none and stdin is piped.
const IMPLICIT_STDIN = new PathSpec({ virtual: '-', directory: '-', vfsPath: '-' })
const DEC = new TextDecoder()

type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

export interface RgFlags {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  byteOffsets: boolean
  countOnly: boolean
  filesOnly: boolean
  filesWithoutMatch: boolean
  wholeWord: boolean
  fixedString: boolean
  onlyMatching: boolean
  withFilename: boolean
  noFilename: boolean
  maxCount: number | null
  afterContext: number
  beforeContext: number
  fileType: string | null
  globPattern: string | null
  hidden: boolean
}

export function parseFlags(fl: FlagView): RgFlags {
  // -c, -l and --files-without-match set one output mode in ripgrep, so
  // the later one on the line wins: `-c --files-without-match` lists the
  // matchless files and `--files-without-match -c` prints counts (ripgrep
  // 14.1.1).
  let listing: string | null = null
  for (const name of fl.typedOrder('c', 'args_l', 'files_without_match')) {
    if (fl.asBool(name)) listing = name
  }
  const a = fl.asInt('A')
  const b = fl.asInt('B')
  const c = fl.asInt('C')
  return {
    ignoreCase: fl.asBool('i'),
    invert: fl.asBool('v'),
    lineNumbers: fl.asBool('n'),
    byteOffsets: fl.asBool('byte_offset'),
    countOnly: listing === 'c',
    filesOnly: listing === 'args_l',
    filesWithoutMatch: listing === 'files_without_match',
    wholeWord: fl.asBool('w'),
    fixedString: fl.asBool('F'),
    onlyMatching: fl.asBool('o'),
    withFilename: fl.asBool('H'),
    noFilename: fl.asBool('args_I'),
    maxCount: fl.asInt('m') ?? null,
    afterContext: a ?? c ?? 0,
    beforeContext: b ?? c ?? 0,
    fileType: fl.asStr('type') ?? null,
    globPattern: fl.asStr('glob') ?? null,
    hidden: fl.asBool('hidden'),
  }
}

// Whether the output shows -A/-B/-C context. Only printed lines carry it: -c,
// -l and --files-without-match answer per file, and -o drops it (ripgrep
// prints -o's context its own way).
export function printsContext(flags: RgFlags): boolean {
  return (
    (flags.beforeContext > 0 || flags.afterContext > 0) &&
    !flags.countOnly &&
    !flags.filesOnly &&
    !flags.filesWithoutMatch &&
    !flags.onlyMatching
  )
}

// The stream reports selection on `io` rather than the caller reading it off
// an empty output: under -o a line whose only match is empty prints nothing
// and is still selected, so it exits 0 (GNU grep 3.11). A line past -m in
// the trailing context prints as ripgrep prints it.
function streamOptionsOf(flags: RgFlags, io: IOResult, signal?: AbortSignal): GrepStreamOptions {
  return {
    invert: flags.invert,
    lineNumbers: flags.lineNumbers,
    byteOffsets: flags.byteOffsets,
    countOnly: flags.countOnly,
    onlyMatching: flags.onlyMatching,
    maxCount: flags.maxCount,
    afterContext: flags.afterContext,
    beforeContext: flags.beforeContext,
    trailingMatches: true,
    io,
    signal,
  }
}

function makeSpec(path: string, template: PathSpec): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: mountKey(path, mountPrefixOf(template.virtual, template.vfsPath)),
  })
}

// The name ripgrep prints for an operand. `-` is `<stdin>`; `/dev/stdin`
// reads the same bytes, but ripgrep opens it as the path it is and names it
// as typed.
function operandName(p: PathSpec): string {
  return p.rawPath === '-' ? STDIN_NAME : p.rawPath
}

// A stdin operand's stat: a stream, never a directory to walk.
function fifoStat(path: string): Promise<FileStat> {
  return Promise.resolve(new FileStat({ name: path, type: FileType.FIFO }))
}

// Whether `source` selects a line, read no further than the first. The
// listing modes need only that one bit, so an unbounded pipe is never
// buffered whole to answer them.
async function selectsAny(
  source: AsyncIterable<Uint8Array>,
  pat: RegExp,
  flags: RgFlags,
  signal?: AbortSignal,
): Promise<boolean> {
  const probe = new IOResult({ exitCode: 1 })
  const scan = grepStream(source, pat, {
    ...streamOptionsOf(flags, probe, signal),
    maxCount: 1,
    countOnly: true,
  })
  for await (const _ of scan) void _
  return probe.exitCode === 0
}

// A stdin operand's records in the full-scan branch, never read whole: -l and
// --files-without-match are settled at the first selected line and -m at its
// last one and that line's trailing context, so a pipe that goes on past the
// answer is never waited on. ripgrep searches stdin whatever --type or --glob
// say, since it never filters an explicit operand.
async function operandRecords(
  source: AsyncIterable<Uint8Array>,
  name: string,
  pat: RegExp,
  flags: RgFlags,
  label: boolean,
  io: IOResult,
  signal?: AbortSignal,
): Promise<string[]> {
  if (flags.filesOnly || flags.filesWithoutMatch) {
    // -m0 reads nothing at all.
    if (flags.maxCount === 0) return []
    const hit = await selectsAny(source, pat, flags, signal)
    if (hit) io.exitCode = 0
    // -l lists a stdin that selected a line, --files-without-match one that
    // selected none.
    return hit === flags.filesOnly ? [name] : []
  }
  const scanned = new IOResult({ exitCode: 1 })
  const scan = grepStream(source, pat, {
    ...streamOptionsOf(flags, scanned, signal),
    contextLabel: label ? name : null,
  })
  const hits = splitLines(decodeLine(await materialize(scan)))
  if (scanned.exitCode === 0) io.exitCode = 0
  if (flags.countOnly) {
    // grepStream prints a zero count; ripgrep lists nothing for it.
    const [count] = hits
    if (count === undefined || count === '0') return []
    return [label ? `${name}:${count}` : count]
  }
  // The context renderer leads each line with the label itself.
  return label && !printsContext(flags) ? hits.map((hit) => `${name}:${hit}`) : hits
}

export async function rgGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  readdir: Readdir,
  stream: Stream,
): Promise<CommandFnResult> {
  // Every `-` operand reads stdin through one cursor, as grep's do. With no
  // operand typed, the implicit one below is stdin's sole reader, so a search
  // that stops early closes the input.
  stream = stdinStream(cacheAwareStream(stream), opts.stdin, paths.length === 0)
  const resolution = await resolvePattern('rg', texts, opts.flags, paths, opts.mountPrefix, stream)
  if (resolution.error !== null) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(resolution.error) })]
  }
  const exprText = resolution.pattern
  if (exprText === null) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${RG_NO_PATTERN}\n`) })]
  }
  const flags = parseFlags(new FlagView(opts.flags, specOf('rg')))
  if (resolution.neverMatch) flags.fixedString = false
  // A line that names no path searches a piped stdin as an implicit `-`
  // operand, so -l, -H, -c and context answer as they do for a typed one
  // (ripgrep's Paths::from_low_args, 14.1.1).
  const [first = IMPLICIT_STDIN] = paths
  if (paths.length === 0) {
    if (opts.stdin === null) {
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${RG_NO_PATTERN}\n`) })]
    }
    paths = [first]
  }
  // ripgrep labels when searching multiple files; -H forces the label for a
  // single file and -I suppresses it (cross-mount fanout forces -H so
  // per-operand native runs stay filename-keyed).
  const label = (paths.length > 1 || flags.withFilename) && !flags.noFilename

  const mounts = opts.ns?.mounts
  const readdirFn = mountParentReaddir(
    (p: string): Promise<string[]> => readdir(makeSpec(p, first)),
    mounts,
  )
  const statFn = mountParentStat((p: string): Promise<FileStat> => stat(makeSpec(p, first)), mounts)
  const readBytesFn = (p: string): Promise<Uint8Array> => materialize(stream(makeSpec(p, first)))

  let needsFull =
    flags.filesOnly ||
    flags.filesWithoutMatch ||
    flags.beforeContext > 0 ||
    flags.afterContext > 0 ||
    flags.fileType !== null ||
    flags.globPattern !== null
  // Every operand is probed, not just the first: a directory anywhere on the
  // line is walked, as ripgrep walks `rg x file dir`. Through the wrapped
  // pair, not the raw ops: a directory that exists only because mounts sit
  // under it answers on neither, so probing raw read the operand as a file,
  // which reports it missing while the fan-out prints hits from the mounts
  // below it.
  for (const p of paths) {
    if (needsFull) break
    try {
      const s = await (isStdin(p) ? fifoStat(p.rawPath) : statFn(p.virtual))
      needsFull = s.type === FileType.DIRECTORY
    } catch (err) {
      if (!isWalkError(err)) throw err
      try {
        await readdirFn(p.virtual)
        needsFull = true
      } catch (probeErr) {
        if (!isWalkError(probeErr)) throw probeErr
        // not readable
      }
    }
  }
  const pat = compilePattern(exprText, flags.ignoreCase, flags.fixedString, flags.wholeWord)
  if (needsFull) {
    const warnings: string[] = []
    const fullOpts = {
      ignoreCase: flags.ignoreCase,
      invert: flags.invert,
      lineNumbers: flags.lineNumbers,
      byteOffsets: flags.byteOffsets,
      countOnly: flags.countOnly,
      filesOnly: flags.filesOnly,
      filesWithoutMatch: flags.filesWithoutMatch,
      fixedString: flags.fixedString,
      onlyMatching: flags.onlyMatching,
      maxCount: flags.maxCount,
      wholeWord: flags.wholeWord,
      contextBefore: flags.beforeContext,
      contextAfter: flags.afterContext,
      fileType: flags.fileType,
      globPattern: flags.globPattern,
      hidden: flags.hidden,
      noFilename: flags.noFilename,
    }
    const results: string[] = []
    // Status comes from selection, not from the printed lines: under -o a
    // zero-width match selects the line and prints nothing, so an empty
    // `results` is not "nothing matched". `grep -r` reads its status the
    // same way.
    const fullIO = new IOResult({ exitCode: 1 })
    // ripgrep puts `--` between one operand's context and the next one's,
    // labelled or not.
    const context = printsContext(flags)
    for (const p of paths) {
      const records = isStdin(p)
        ? await operandRecords(stream(p), operandName(p), pat, flags, label, fullIO, opts.signal)
        : respellRaw(
            await rgFull(
              readdirFn,
              statFn,
              readBytesFn,
              p.virtual,
              exprText,
              fullOpts,
              warnings,
              label ? p.rawPath : null,
              fullIO,
            ),
            p.virtual,
            p.rawPath,
          )
      if (context && results.length > 0 && records.length > 0) results.push('--')
      results.push(...records)
    }
    const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
    // `exitCodeFor` is the one contract both commands share: an operand the
    // search could not read is exit 2 and it outranks a match. This branch
    // answered 1 where the python twin, the multi-operand branch below and
    // `grep` all answer 2.
    // ripgrep's status under --files-without-match follows the listing, not
    // the matching: 0 when a file was listed, 1 when every file matched
    // (14.1.1; GNU grep keeps the match status).
    const selected =
      flags.filesWithoutMatch && !flags.countOnly ? results.length > 0 : fullIO.exitCode === 0
    const code = exitCodeFor(selected, warnings.length > 0, false)
    if (results.length === 0) {
      const io = new IOResult({
        exitCode: code,
        ...(stderr !== undefined ? { stderr } : {}),
      })
      return [new Uint8Array(0), io]
    }
    const out: ByteSource = formatRecords(results)
    const io = new IOResult({
      exitCode: code,
      ...(stderr !== undefined ? { stderr } : {}),
    })
    return [out, io]
  }

  if (flags.countOnly) {
    const streamOpts = {
      invert: flags.invert,
      lineNumbers: false,
      byteOffsets: false,
      onlyMatching: flags.onlyMatching,
      maxCount: flags.maxCount,
      countOnly: true,
      afterContext: 0,
      beforeContext: 0,
      signal: opts.signal,
    }
    if (paths.length > 1 || flags.withFilename) {
      const results: string[] = []
      const warnings: string[] = []
      for (const p of paths) {
        let counted: Uint8Array
        try {
          counted = await materialize(grepStream(stream(p), pat, streamOpts))
        } catch (err) {
          if (!isFsError(err)) throw err
          // ripgrep reports the failed operand and keeps searching the rest.
          warnings.push(`rg: ${p.rawPath}: ${String(fsStrerror(err))}`)
          continue
        }
        const n = Number.parseInt(DEC.decode(counted).trim() || '0', 10)
        if (n > 0) results.push(label ? `${operandName(p)}:${String(n)}` : String(n))
      }
      const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
      const code = exitCodeFor(results.length > 0, warnings.length > 0, false)
      if (results.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({ exitCode: code, ...(stderr !== undefined ? { stderr } : {}) }),
        ]
      return [
        ENC.encode(results.join('\n') + '\n'),
        new IOResult({
          exitCode: code,
          ...(stderr !== undefined ? { stderr } : {}),
        }),
      ]
    }
    const io = new IOResult({ exitCode: 1 })
    const counted = nonzeroCountStream(grepStream(stream(first), pat, { ...streamOpts, io }))
    return [counted, io]
  }

  if (paths.length > 1 || flags.withFilename) {
    const results: string[] = []
    const warnings: string[] = []
    let selected = false
    for (const p of paths) {
      let data: Uint8Array
      const fileIO = new IOResult({ exitCode: 1 })
      try {
        const matched = grepStream(stream(p), pat, streamOptionsOf(flags, fileIO, opts.signal))
        data = await materialize(label ? prefixLines(matched, operandName(p) + ':') : matched)
      } catch (error) {
        if (!isFsError(error)) throw error
        warnings.push(`rg: ${p.rawPath}: ${String(fsStrerror(error))}`)
        continue
      }
      selected ||= fileIO.exitCode === 0
      if (data.length) results.push(DEC.decode(data))
    }
    return [
      ENC.encode(results.join('')),
      new IOResult({
        exitCode: exitCodeFor(selected, warnings.length > 0, false),
        ...(warnings.length ? { stderr: ENC.encode(warnings.join('\n') + '\n') } : {}),
      }),
    ]
  }

  try {
    await (isStdin(first) ? fifoStat(first.rawPath) : statFn(first.virtual))
  } catch (error) {
    if (!isFsError(error)) throw error
    return [
      new Uint8Array(),
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode(`rg: ${first.rawPath}: ${String(fsStrerror(error))}\n`),
      }),
    ]
  }
  const io = new IOResult({ exitCode: 1 })
  return [grepStream(stream(first), pat, streamOptionsOf(flags, io, opts.signal)), io]
}
