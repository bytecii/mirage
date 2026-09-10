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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { cacheAwareStreamEager } from '../../../cache/read_through.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import { usageHint } from '../../spec/usage.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import {
  countNewlines,
  normalizeCounts,
  numberFlagError,
  parseCounts,
  tailBytes,
  type TailCounts,
} from '../tail_counts.ts'
import { fsErrorLine, fsStrerror, isFsError } from '../../../utils/errors.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
type Stat = (p: PathSpec) => Promise<FileStat>
type ReadRange = (p: PathSpec, offset: number, size: number) => Promise<Uint8Array>

const DEFAULT_SLEEP_INTERVAL = 1

/** -f/--follow[=HOW], -F, --retry and -s as tail reads them. */
interface FollowFlags {
  readonly follow: boolean
  readonly byName: boolean
  readonly retry: boolean
  readonly interval: number
}

// -f, --follow[=HOW] and -F. A bad HOW is GNU's ARGMATCH refusal; -F is
// --follow=name --retry.
function followFlags(fl: FlagView): FollowFlags | string {
  const raw: unknown = fl.raw('follow')
  let follow = raw !== undefined && raw !== null && raw !== false
  let byName = false
  if (typeof raw === 'string') {
    if (raw === 'name') byName = true
    else if (raw !== 'descriptor') {
      return (
        `tail: invalid argument '${raw}' for '--follow'\n` +
        "Valid arguments are:\n  - 'descriptor'\n  - 'name'\n" +
        `${usageHint('tail')}\n`
      )
    }
  }
  let retry = fl.asBool('retry')
  if (fl.asBool('F')) {
    follow = true
    byName = true
    retry = true
  }
  const rawSeconds = fl.asStr('sleep_interval')
  let interval = DEFAULT_SLEEP_INTERVAL
  if (rawSeconds !== undefined) {
    interval = rawSeconds.trim() === '' ? Number.NaN : Number(rawSeconds)
    if (!Number.isFinite(interval) || interval < 0) {
      return `tail: invalid number of seconds: '${rawSeconds}'\n`
    }
  }
  return { follow, byName, retry, interval }
}

// Append a follow-time diagnostic to the result's stderr. A following
// tail's stdout is a stream the caller drains as the file grows, and its
// stderr is the bytes on the result, which the caller reads once the
// stream ends; a notice raised mid-follow lands there.
function note(io: IOResult, message: string): void {
  const prior = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
  io.stderr = concat([prior, ENC.encode(message)])
}

// Whether the caller's signal has fired; a call rather than a read so a
// loop re-asks after every await instead of trusting a narrowed value.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

// Sleep for the poll interval, or until the caller's signal fires.
async function pause(seconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (aborted(signal)) return
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, seconds * 1000)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function window(
  stream: Stream,
  readRange: ReadRange | null,
  p: PathSpec,
  offset: number,
  size: number,
): Promise<Uint8Array> {
  if (readRange !== null) return await readRange(p, offset, size)
  const whole = await materialize(stream(p))
  return whole.slice(offset, offset + size)
}

// Print each operand's tail, then keep printing what it gains. GNU tail
// -f is a poll: every -s seconds each followed file is stat'ed, bytes
// past the last position are printed under that file's header when the
// previous output was another file's, and a size that shrank is `file
// truncated` and a restart from the top. A file that goes away is
// dropped with `has become inaccessible` under --follow=name; --retry
// keeps polling for it (and for one that was never there) and announces
// `has appeared` when it turns up, reading it from the start as GNU does
// after a rotation. The loop ends only when nothing is left to follow
// (`no files remaining`, exit 1) or the caller's signal fires, which is
// how `timeout` and a killed job end it.
async function* follow(
  paths: readonly PathSpec[],
  pending: PathSpec[],
  stream: Stream,
  stat: Stat,
  readRange: ReadRange | null,
  counts: TailCounts,
  showHeaders: boolean,
  flags: FollowFlags,
  io: IOResult,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const positions = new Map<string, number>()
  const active = [...paths]
  let last: string | null = null
  for (const p of active) {
    const raw = await materialize(stream(p))
    if (showHeaders) {
      yield ENC.encode(`${last === null ? '' : '\n'}==> ${p.rawPath} <==\n`)
    }
    last = p.virtual
    yield tailBytes(raw, counts)
    positions.set(p.virtual, raw.byteLength)
  }
  while ((active.length > 0 || pending.length > 0) && !aborted(signal)) {
    await pause(flags.interval, signal)
    if (aborted(signal)) return
    for (const p of [...pending]) {
      let found: FileStat
      try {
        found = await stat(p)
      } catch (err) {
        if (!isFsError(err)) throw err
        continue
      }
      if (found.type === FileType.DIRECTORY) continue
      note(io, `tail: '${p.rawPath}' has appeared;  following new file\n`)
      pending.splice(pending.indexOf(p), 1)
      active.push(p)
      positions.set(p.virtual, 0)
    }
    for (const p of [...active]) {
      let current: FileStat
      try {
        current = await stat(p)
      } catch (err) {
        if (!isFsError(err)) throw err
        if (flags.byName || flags.retry) {
          note(
            io,
            `tail: '${p.rawPath}' has become inaccessible: ${fsStrerror(err) ?? 'No such file or directory'}\n`,
          )
          active.splice(active.indexOf(p), 1)
          if (flags.retry) pending.push(p)
        }
        continue
      }
      const size = current.size
      if (size === null) continue
      let pos = positions.get(p.virtual) ?? 0
      if (size < pos) {
        note(io, `tail: ${p.rawPath}: file truncated\n`)
        pos = 0
      }
      if (size > pos) {
        const data = await window(stream, readRange, p, pos, size - pos)
        if (showHeaders && last !== p.virtual) yield ENC.encode(`\n==> ${p.rawPath} <==\n`)
        last = p.virtual
        if (data.byteLength > 0) yield data
        pos += data.byteLength
      }
      positions.set(p.virtual, pos)
    }
  }
  if (aborted(signal)) return
  note(io, 'tail: no files remaining\n')
  io.exitCode = 1
}

// Sort the operands that did not open into the ones --retry waits for and
// the ones tail gives up on, wording the latter.
async function unfollowable(
  paths: readonly PathSpec[],
  opened: ReadonlySet<string>,
  stat: Stat,
  retry: boolean,
  io: IOResult,
): Promise<PathSpec[]> {
  const pending: PathSpec[] = []
  for (const p of paths) {
    if (opened.has(p.virtual)) continue
    let found: FileStat
    try {
      found = await stat(p)
    } catch (err) {
      if (!isFsError(err)) throw err
      if (retry) pending.push(p)
      continue
    }
    if (found.type === FileType.DIRECTORY) {
      note(
        io,
        `tail: ${p.rawPath}: cannot follow end of this type of file; giving up on this name\n`,
      )
    }
  }
  return pending
}

// Whether this operand's whole content is what tail emits, which is what
// makes it worth handing to the file cache. Counting from the start is
// never treated as a full read, matching what `-n +N` has always done.
function readsEverything(rawCounts: TailCounts, raw: Uint8Array): boolean {
  const counts = normalizeCounts(rawCounts)
  if (counts.fromByte !== null || counts.fromLine !== null) return false
  if (counts.byteCount !== null) return counts.byteCount >= raw.byteLength
  return (counts.lines ?? 10) >= countNewlines(raw)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function tailGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
  stat: Stat | null = null,
  readRange: ReadRange | null = null,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('tail'))
  stream = cacheAwareStreamEager(stream)
  const nRaw = fl.asStr('n') ?? null
  const cRaw = fl.asStr('c') ?? null
  const numErr = numberFlagError('tail', nRaw, cRaw)
  if (numErr !== null) return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(numErr) })]
  const following = followFlags(fl)
  if (typeof following === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(following) })]
  const qFlag = fl.asBool('q')
  const vFlag = fl.asBool('v')
  const counts = parseCounts(nRaw, cRaw)
  if (paths.length > 0 && following.follow && stat !== null) {
    const showHeaders = (vFlag || paths.length > 1) && !qFlag
    const readable: PathSpec[] = []
    let err = ''
    for (const p of paths) {
      try {
        const found = await stat(p)
        if (found.type === FileType.DIRECTORY) {
          err += `tail: error reading '${p.rawPath}': Is a directory\n`
          continue
        }
        readable.push(p)
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('tail', p, e)
      }
    }
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : ENC.encode(err),
    })
    const pending = await unfollowable(
      paths,
      new Set(readable.map((p) => p.virtual)),
      stat,
      following.retry,
      io,
    )
    if (readable.length === 0 && pending.length === 0) {
      note(io, 'tail: no files remaining\n')
      io.exitCode = 1
      return [null, io]
    }
    return [
      follow(
        readable,
        pending,
        stream,
        stat,
        readRange,
        counts,
        showHeaders,
        following,
        io,
        opts.signal,
      ),
      io,
    ]
  }

  if (paths.length > 0) {
    const chunks: Uint8Array[] = []
    const cache: string[] = []
    const showHeaders = (vFlag || paths.length > 1) && !qFlag
    let err = ''
    let printed = 0
    for (const p of paths) {
      let raw: Uint8Array
      try {
        raw = await materialize(stream(p))
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('tail', p, e)
        continue
      }
      if (showHeaders) {
        // Separator keyed on printed blocks, not operand index: a good file
        // after a failed operand starts without a leading blank line (GNU).
        const header = printed > 0 ? `\n==> ${p.rawPath} <==\n` : `==> ${p.rawPath} <==\n`
        chunks.push(ENC.encode(header))
      }
      printed += 1
      chunks.push(tailBytes(raw, counts))
      if (readsEverything(counts, raw)) cache.push(p.virtual)
    }
    const io = new IOResult({
      cache,
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : ENC.encode(err),
    })
    if (printed === 0 && err !== '') return [null, io]
    const out: ByteSource = concat(chunks)
    return [out, io]
  }
  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tail: missing operand\n') })]
  }
  return [tailBytes(raw, counts), new IOResult()]
}
