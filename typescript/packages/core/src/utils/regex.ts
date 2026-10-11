import { Worker } from '../concurrency/worker.ts'
import { foldsAsciiOnly } from './posix.ts'
import type { Match } from './regex_scan.ts'

/** Prepared match data preserves synchronous rendering without running the engine there. */
export class AsyncRegex extends RegExp {
  private readonly worker: Worker
  private readonly ownsWorker: boolean
  private readonly cache = new Map<string, RegExpExecArray[]>()
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

  async prepare(text: string, following?: () => string[]): Promise<void> {
    const cached = this.cache.get(text)
    if (cached !== undefined) {
      this.cache.delete(text)
      this.cache.set(text, cached)
      return
    }
    const subjects = [...new Set([text, ...(following?.() ?? [])])].slice(0, 32)
    const missing = subjects.filter((subject) => !this.cache.has(subject))
    const results = await this.worker.call<Match[][]>(
      'scanMany',
      [
        this.original.source,
        this.original.flags,
        foldsAsciiOnly(this.original),
        missing,
        this.allMatches,
      ],
      this.signal,
    )
    for (const [index, subject] of missing.entries()) {
      this.cache.set(
        subject,
        (results[index] ?? []).map((match) => {
          const native = match.values as RegExpExecArray
          native.index = match.index
          native.input = subject
          if (match.groups !== undefined) native.groups = match.groups
          if (match.indices !== undefined) native.indices = match.indices
          return native
        }),
      )
    }
    for (const subject of subjects) {
      const matches = this.matches(subject)
      this.cache.delete(subject)
      this.cache.set(subject, matches)
    }
    while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value ?? '')
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

  async close(): Promise<void> {
    if (this.ownsWorker) await this.worker.close()
    this.cache.clear()
  }
}

export async function prepare(pattern: RegExp, text: string): Promise<void> {
  if (pattern instanceof AsyncRegex) await pattern.prepare(text)
}
