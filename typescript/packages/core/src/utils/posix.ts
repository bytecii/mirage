export const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-/:-@\\[-`{-~',
  print: ' -~',
  graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
}

/** Translate one bracket expression; returns the index past its `]`. */
export function translateBracket(pattern: string, start: number, out: string[]): number {
  let idx = start + 1
  out.push('[')
  if (pattern.charAt(idx) === '^') {
    out.push('^')
    idx += 1
  }
  // A `]` in the first position is a literal member in an ERE, but the
  // host engine would read it as the end of the bracket expression.
  if (pattern.charAt(idx) === ']') {
    out.push('\\]')
    idx += 1
  }
  while (idx < pattern.length) {
    const ch = pattern.charAt(idx)
    if (ch === ']') {
      out.push(']')
      return idx + 1
    }
    if (pattern.startsWith('[:', idx)) {
      const close = pattern.indexOf(':]', idx + 2)
      if (close === -1) {
        out.push('\\[')
        idx += 1
        continue
      }
      const name = pattern.slice(idx + 2, close)
      const expansion = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined
      if (expansion === undefined) throw new SyntaxError('Invalid character class name')
      out.push(expansion)
      idx = close + 2
      continue
    }
    if (ch === '\\' && idx + 1 < pattern.length) {
      out.push(pattern.slice(idx, idx + 2))
      idx += 2
      continue
    }
    if (ch === '[') {
      out.push('\\[')
      idx += 1
      continue
    }
    out.push(ch)
    idx += 1
  }
  throw new SyntaxError('Unmatched [, [^, [:, [., or [=')
}

const INTERVAL = /\{\d+(?:,\d*)?\}/y

/**
 * Expand POSIX brackets while preserving regex operators and escapes. With
 * `nest`, a quantifier stacked on a quantified atom repeats that whole
 * repetition, the way glibc reads an ERE: `a++` is `(a+)+` and `a+?` is
 * `(a+)?`, never a syntax error or the host's lazy form.
 */
export function translateClasses(pattern: string, nest = true): string {
  const out: string[] = []
  const groups: number[] = []
  let atom: number | null = null
  let quantified = false
  let idx = 0
  while (idx < pattern.length) {
    const ch = pattern.charAt(idx)
    INTERVAL.lastIndex = idx
    const interval = ch === '{' ? INTERVAL.exec(pattern) : null
    if ('*+?'.includes(ch) || interval !== null) {
      const token = interval?.[0] ?? ch
      if (nest && quantified && atom !== null)
        out.splice(atom, out.length - atom, '(?:', ...out.slice(atom), ')')
      out.push(token)
      quantified = atom !== null
      idx += token.length
      continue
    }
    quantified = false
    if (ch === '\\' && idx + 1 < pattern.length) {
      atom = out.length
      out.push(pattern.slice(idx, idx + 2))
      idx += 2
    } else if (ch === '[') {
      atom = out.length
      idx = translateBracket(pattern, idx, out)
    } else if (ch === '(') {
      groups.push(out.length)
      atom = null
      out.push(ch)
      idx += 1
    } else if (ch === ')') {
      atom = groups.pop() ?? null
      out.push(ch)
      idx += 1
    } else {
      atom = '|^$'.includes(ch) ? null : out.length
      out.push(ch)
      idx += 1
    }
  }
  return out.join('')
}

export function classCharacters(name: string): string {
  const expansion = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined
  if (expansion === undefined) throw new Error(`tr: invalid character class '${name}'`)
  const pattern = new RegExp('[' + expansion + ']')
  return Array.from({ length: 128 }, (_, n) => String.fromCharCode(n))
    .filter((ch) => pattern.test(ch))
    .join('')
}
