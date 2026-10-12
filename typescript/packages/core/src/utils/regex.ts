import { Worker } from '../concurrency/worker.ts'
import { foldsAsciiOnly } from './posix.ts'
import type { Match } from './regex_scan.ts'

/**
 * Matches found in a worker, rendered here. Each subject is its own call, so
 * a slow subject sent ahead never holds back the answer for one before it.
 */
export class AsyncRegex extends RegExp {
  private readonly worker: Worker
  private readonly ownsWorker: boolean
  private readonly cache = new Map<string, RegExpExecArray[]>()
  private readonly sent = new Map<string, Promise<RegExpExecArray[]>>()
  constructor(
    private readonly original: RegExp,
    private readonly signal?: AbortSignal,
    private readonly allMatches = true,
    worker?: Worker,
  ) {
    super(original.source, original.flags)
    this.ownsWorker = worker === undefined
    this.worker = worker ?? new Worker()
  }

  /** Fetch `text`'s matches, sending the subjects buffered behind it along. */
  async prepare(text: string, following?: () => string[]): Promise<void> {
    const cached = this.cache.get(text)
    if (cached !== undefined) {
      this.cache.delete(text)
      this.cache.set(text, cached)
      return
    }
    if (!this.sent.has(text))
      for (const subject of [text, ...(following?.() ?? [])])
        if (!this.cache.has(subject) && !this.sent.has(subject))
          this.sent.set(subject, this.scan(subject))
    // Answers come in order, so every subject sent before `text` has one too.
    for (const [subject, matches] of this.sent) {
      this.sent.delete(subject)
      this.cache.set(subject, await matches)
      if (subject === text) break
    }
    while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value ?? '')
  }

  private scan(subject: string): Promise<RegExpExecArray[]> {
    const matches = this.worker
      .call<Match[]>(
        'scan',
        [
          this.original.source,
          this.original.flags,
          foldsAsciiOnly(this.original),
          subject,
          this.allMatches,
        ],
        this.signal,
      )
      .then((found) =>
        found.map((match) => {
          const native = match.values as RegExpExecArray
          native.index = match.index
          native.input = subject
          if (match.groups !== undefined) native.groups = match.groups
          if (match.indices !== undefined) native.indices = match.indices
          return native
        }),
      )
    // prepare awaits it in order; one it never reaches is dropped unread.
    matches.catch(() => undefined)
    return matches
  }

  matches(text: string): RegExpExecArray[] {
    const matches = this.cache.get(text)
    if (matches === undefined) throw new Error('regex subject was not prepared')
    return matches
  }

  search(text: string, from = 0): RegExpExecArray | null {
    const matches = this.matches(text)
    let lo = 0,
      hi = matches.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((matches[mid]?.index ?? 0) < from) lo = mid + 1
      else hi = mid
    }
    return matches[lo] ?? null
  }

  override exec(text: string): RegExpExecArray | null {
    const match = this.search(text, this.global || this.sticky ? this.lastIndex : 0)
    if (this.global || this.sticky)
      this.lastIndex = match === null ? 0 : match.index + match[0].length
    return match
  }

  /** Answers still owed for a shared worker resolve unread. */
  async close(): Promise<void> {
    if (this.ownsWorker) await this.worker.close()
    this.sent.clear()
    this.cache.clear()
  }
}

export async function prepare(pattern: RegExp, text: string): Promise<void> {
  if (pattern instanceof AsyncRegex) await pattern.prepare(text)
}
