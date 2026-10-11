import { compilePosixRegex } from './posix.ts'

export interface Match {
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

export function scanMany(
  source: string,
  flags: string,
  ascii: boolean,
  texts: string[],
  allMatches: boolean,
): Match[][] {
  return texts.map((text) => scan(source, flags, ascii, text, allMatches))
}
