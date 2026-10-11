import { Worker } from '../concurrency/worker.ts'
import { compilePosixRegex, foldsAsciiOnly } from './posix.ts'

interface Match {
  values: string[]
  index: number
  groups: RegExpExecArray['groups']
  indices: RegExpExecArray['indices']
}

/** Evaluate the native regexp only inside an invocation-owned worker. */
export function scan(
  source: string,
  flags: string,
  ascii: boolean,
  text: string,
  allMatches = true,
): Match[] {
  const global = flags.includes('g') ? flags : flags + 'g'
  const pattern = ascii ? compilePosixRegex(source, global) : new RegExp(source, global)
  // Structured clone copies strings by value: sending each match's .input
  // would turn a dense line into quadratic wire size and memory.
  const first = allMatches ? null : pattern.exec(text)
  const matches = allMatches ? text.matchAll(pattern) : first === null ? [] : [first]
  return Array.from(matches, (match) => ({
    values: [...match],
    index: match.index,
    groups: match.groups,
    indices: match.indices,
  }))
}

/** Prepared match data preserves synchronous rendering without running the engine there. */
export class AsyncRegex extends RegExp {
  private readonly worker = new Worker()
  private readonly cache = new Map<string, RegExpExecArray[]>()
  constructor(
    private readonly original: RegExp,
    private readonly signal?: AbortSignal,
    private readonly allMatches = true,
  ) {
    super(original.source, original.flags)
  }

  async prepare(text: string): Promise<void> {
    const cached = this.cache.get(text)
    if (cached !== undefined) {
      this.cache.delete(text)
      this.cache.set(text, cached)
      return
    }
    const result = await this.worker.call<Match[]>(
      new URL(import.meta.url),
      'scan',
      [
        this.original.source,
        this.original.flags,
        foldsAsciiOnly(this.original),
        text,
        this.allMatches,
      ],
      this.signal,
    )
    this.cache.set(
      text,
      result.map((match) => {
        const native = match.values as RegExpExecArray
        native.index = match.index
        native.input = text
        if (match.groups !== undefined) native.groups = match.groups
        if (match.indices !== undefined) native.indices = match.indices
        return native
      }),
    )
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value ?? '')
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
    await this.worker.close()
    this.cache.clear()
  }
}

export async function prepare(pattern: RegExp, text: string): Promise<void> {
  if (pattern instanceof AsyncRegex) await pattern.prepare(text)
}
