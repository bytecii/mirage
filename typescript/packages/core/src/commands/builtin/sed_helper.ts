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

const SIMPLE_CMDS = new Set(['d', 'D', 'p', 'P', 'h', 'H', 'g', 'G', 'x', 'N', 'q'])

export type SedAddr = ['line', string] | ['last', ''] | ['regex', string]

export interface SedCommand {
  cmd: string
  addrStart?: SedAddr | null
  addrEnd?: SedAddr | null
  pattern?: string
  replacement?: string
  exprFlags?: string
  text?: string
  label?: string
}

function parseAddress(addr: string): SedAddr | null {
  if (addr === '') return null
  if (addr.startsWith('/')) {
    const end = addr.indexOf('/', 1)
    return ['regex', addr.slice(1, end)]
  }
  if (/^\d+$/.test(addr)) return ['line', addr]
  if (addr === '$') return ['last', '']
  return null
}

function consumeAddress(rest: string): [SedAddr | null, string] {
  if (rest === '') return [null, rest]
  if (rest.startsWith('/')) {
    const end = rest.indexOf('/', 1)
    const addr: SedAddr = ['regex', rest.slice(1, end)]
    return [addr, rest.slice(end + 1)]
  }
  const first = rest[0]
  if (first !== undefined && (/\d/.test(first) || first === '$')) {
    let num = ''
    while (rest.length > 0) {
      const c: string | undefined = rest[0]
      if (c === undefined || !(/\d/.test(c) || c === '$')) break
      num += c
      rest = rest.slice(1)
    }
    return [parseAddress(num), rest]
  }
  return [null, rest]
}

function readLabelOrBranch(rest: string): [string, string] {
  let label = ''
  while (rest.length > 0) {
    const c: string | undefined = rest[0]
    if (c === undefined || c === ';' || c === '}') break
    label += c
    rest = rest.slice(1)
  }
  return [label.trim(), rest]
}

export function parseOneCommand(rest: string): [SedCommand, string] {
  let addrStart: SedAddr | null = null
  let addrEnd: SedAddr | null = null
  ;[addrStart, rest] = consumeAddress(rest)
  if (addrStart !== null && rest.startsWith(',')) {
    ;[addrEnd, rest] = consumeAddress(rest.slice(1))
  }
  if (rest === '') throw new Error('sed: missing command')
  const ch = rest[0]
  if (ch === '{') return [{ cmd: '{', addrStart, addrEnd }, rest.slice(1)]
  if (ch === '}') return [{ cmd: '}' }, rest.slice(1)]
  if (ch === ':') {
    const [label, after] = readLabelOrBranch(rest.slice(1))
    return [{ cmd: ':', label }, after]
  }
  if (ch === 'b' || ch === 't') {
    const [label, after] = readLabelOrBranch(rest.slice(1))
    return [{ cmd: ch, label, addrStart, addrEnd }, after]
  }
  if (ch === 's') {
    const delim = rest[1]
    if (delim === undefined) throw new Error('sed: missing delimiter')
    const parts = rest.slice(2).split(delim)
    const pattern = parts[0] ?? ''
    const replacement = parts.length > 1 ? (parts[1] ?? '') : ''
    const exprFlags = parts.length > 2 ? (parts[2] ?? '') : ''
    const remaining = parts.length > 3 ? parts.slice(3).join(delim) : ''
    return [{ cmd: 's', pattern, replacement, exprFlags, addrStart, addrEnd }, remaining]
  }
  if (ch !== undefined && SIMPLE_CMDS.has(ch)) {
    return [{ cmd: ch, addrStart, addrEnd }, rest.slice(1)]
  }
  if (ch === 'a' || ch === 'i') {
    let text = rest.slice(1)
    if (text.startsWith('\\') || text.startsWith(' ')) text = text.slice(1)
    let end = text.length
    for (let j = 0; j < text.length; j++) {
      if (text[j] === ';') {
        end = j
        break
      }
    }
    return [{ cmd: ch, text: text.slice(0, end), addrStart, addrEnd }, text.slice(end)]
  }
  throw new Error(`sed: unsupported command: ${String(ch)}`)
}

export function parseProgram(expr: string): SedCommand[] {
  const commands: SedCommand[] = []
  let rest = expr.trim()
  while (rest !== '') {
    const first = rest[0]
    if (first === ';' || first === '\n') {
      rest = rest.slice(1).replace(/^\s+/, '')
      continue
    }
    if (first === ' ') {
      rest = rest.slice(1)
      continue
    }
    const [cmd, after] = parseOneCommand(rest)
    commands.push(cmd)
    rest = after.replace(/^\s+/, '')
  }
  return commands
}

function addrMatches(addr: SedAddr, line: string, lineno: number, total: number): boolean {
  const [kind, val] = addr
  if (kind === 'line') return lineno === Number.parseInt(val, 10)
  if (kind === 'last') return lineno === total
  // kind === 'regex'
  // Match against the line content, excluding the preserved trailing newline,
  // so anchored addresses like /^[0-9]*$/ behave per POSIX/GNU sed (and the
  // Python implementation). See issue #326.
  const subject = line.endsWith('\n') ? line.slice(0, -1) : line
  return new RegExp(val).test(subject)
}

export function translateReplacement(repl: string): string {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const ch = repl[i]
    if (ch === '$') {
      out += '$$'
      continue
    }
    if (ch === '\\' && i + 1 < repl.length) {
      const next = repl[i + 1]
      if (next !== undefined && /[0-9]/.test(next)) {
        out += '$' + next
        i += 1
        continue
      }
      if (next === '\\') {
        out += '\\'
        i += 1
        continue
      }
      if (next === '&') {
        out += '&'
        i += 1
        continue
      }
      if (next === 'n') {
        out += '\n'
        i += 1
        continue
      }
      if (next === 't') {
        out += '\t'
        i += 1
        continue
      }
      out += next ?? ''
      i += 1
      continue
    }
    out += ch ?? ''
  }
  return out
}

function regexReplace(
  text: string,
  pat: string,
  repl: string,
  ignoreCase: boolean,
  global: boolean,
  count = 1,
): string {
  // POSIX sed line semantics: `^`/`$` anchor to the line content, not the
  // line-separator newline that splitLinesKeepEnds preserves. JS `$` (without
  // the `m` flag) only matches the absolute end of input, so an anchored
  // substitution like `s/^#[0-9]*$/.../ ` is a no-op against "#123\n". Strip a
  // single trailing newline before substituting and re-append it afterwards so
  // the anchors see line content — matching the Python implementation and GNU
  // sed (whose pattern space excludes the trailing newline). See issue #326.
  const hasNewline = text.endsWith('\n')
  const body = hasNewline ? text.slice(0, -1) : text
  // `count` is the 1-based occurrence the substitution starts at (GNU sed's
  // numeric `s///N` flag, default 1). Without `g` only that single occurrence
  // is replaced; with `g` that occurrence and every later one are. Iterate all
  // matches and decide per match so `N` and `Ng` both work.
  const baseFlags = ignoreCase ? 'i' : ''
  const scan = new RegExp(pat, baseFlags + 'g')
  const single = new RegExp(pat, baseFlags)
  const jsRepl = translateReplacement(repl)
  let n = 0
  const out = body.replace(scan, (m: string) => {
    n += 1
    const hit = global ? n >= count : n === count
    return hit ? m.replace(single, jsRepl) : m
  })
  return hasNewline ? out + '\n' : out
}

function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

export function executeProgram(text: string, commands: SedCommand[], suppress = false): string {
  const lines = splitLinesKeepEnds(text)
  const total = lines.length
  let hold = ''
  const output: string[] = []
  const labelMap = new Map<string, number>()
  for (let idx = 0; idx < commands.length; idx++) {
    const c = commands[idx]
    if (c?.cmd === ':' && c.label !== undefined) labelMap.set(c.label, idx)
  }
  const rangeActive = new Map<number, boolean>()

  let i = 0
  while (i < total) {
    let pattern = lines[i] ?? ''
    i += 1
    const lineno = i
    const deferred: string[] = []
    let pc = 0
    let deleteFlag = false
    let substituted = false

    while (pc < commands.length) {
      const cmd = commands[pc]
      if (cmd === undefined) {
        pc += 1
        continue
      }
      const c = cmd.cmd
      if (c === ':' || c === '}') {
        pc += 1
        continue
      }

      let matched = true
      if (cmd.addrStart !== null && cmd.addrStart !== undefined) {
        if (cmd.addrEnd !== null && cmd.addrEnd !== undefined) {
          const rid = pc
          if (rangeActive.get(rid) !== true) {
            if (addrMatches(cmd.addrStart, pattern, lineno, total)) rangeActive.set(rid, true)
            else matched = false
          }
          if (rangeActive.get(rid) === true) {
            if (addrMatches(cmd.addrEnd, pattern, lineno, total)) rangeActive.set(rid, false)
          }
        } else {
          if (!addrMatches(cmd.addrStart, pattern, lineno, total)) matched = false
        }
      }

      if (c === '{') {
        if (!matched) {
          let depth = 1
          pc += 1
          while (pc < commands.length && depth > 0) {
            const next = commands[pc]
            if (next?.cmd === '{') depth += 1
            else if (next?.cmd === '}') depth -= 1
            pc += 1
          }
          continue
        }
        pc += 1
        continue
      }

      if (!matched) {
        pc += 1
        continue
      }

      if (c === 's') {
        const pat = cmd.pattern ?? ''
        const repl = cmd.replacement ?? ''
        const ef = cmd.exprFlags ?? ''
        const countMatch = /[0-9]+/.exec(ef)
        const count = countMatch ? Number.parseInt(countMatch[0], 10) : 1
        const newPattern = regexReplace(pattern, pat, repl, ef.includes('i'), ef.includes('g'), count)
        const changed = newPattern !== pattern
        if (changed) substituted = true
        pattern = newPattern
        // `s///p` prints the pattern space when a substitution was made.
        if (changed && ef.includes('p')) output.push(pattern)
      } else if (c === 'd') {
        deleteFlag = true
        break
      } else if (c === 'D') {
        const nl = pattern.indexOf('\n')
        if (nl >= 0) {
          pattern = pattern.slice(nl + 1)
          pc = 0
          continue
        }
        deleteFlag = true
        break
      } else if (c === 'p') {
        output.push(pattern)
      } else if (c === 'P') {
        const nl = pattern.indexOf('\n')
        output.push(nl >= 0 ? pattern.slice(0, nl + 1) : pattern)
      } else if (c === 'N') {
        if (i < total) {
          pattern += lines[i] ?? ''
          i += 1
        } else {
          break
        }
      } else if (c === 'h') {
        hold = pattern
      } else if (c === 'H') {
        hold = hold !== '' ? hold + '\n' + pattern : pattern
      } else if (c === 'g') {
        pattern = hold
      } else if (c === 'G') {
        pattern = hold !== '' ? pattern + '\n' + hold : pattern
      } else if (c === 'x') {
        const tmp = pattern
        pattern = hold
        hold = tmp
      } else if (c === 'a') {
        deferred.push((cmd.text ?? '') + '\n')
      } else if (c === 'i') {
        output.push((cmd.text ?? '') + '\n')
      } else if (c === 'q') {
        output.push(pattern)
        return output.join('')
      } else if (c === 'b') {
        const label = cmd.label ?? ''
        const target = labelMap.get(label)
        if (label !== '' && target !== undefined) {
          pc = target
          continue
        }
        break
      } else if (c === 't') {
        if (substituted) {
          substituted = false
          const label = cmd.label ?? ''
          const target = labelMap.get(label)
          if (label !== '' && target !== undefined) {
            pc = target
            continue
          }
          break
        }
      }

      pc += 1
    }

    if (!deleteFlag) {
      if (!suppress) output.push(pattern)
      for (const d of deferred) output.push(d)
    }
  }
  return output.join('')
}
