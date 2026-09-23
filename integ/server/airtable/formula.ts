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

export type FValue = string | number | boolean | null

export class FormulaSyntaxError extends Error {}

export class UnknownFieldsError extends Error {
  readonly names: string[]

  constructor(names: string[]) {
    super(`unknown fields: ${names.join(', ')}`)
    this.names = names
  }
}

type Kind = 'num' | 'str' | 'field' | 'ident' | 'op' | 'lp' | 'rp' | 'comma'

interface Tok {
  kind: Kind
  text: string
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'field'; ref: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'bin'; op: string; left: Node; right: Node }
  | { kind: 'neg'; arg: Node }

// A deliberately SMALL subset of Airtable's formula language, shared by
// filterByFormula, a view's filter and the formula FIELD, so the three cannot
// disagree about what a formula means. What it accepts:
//
//   literals     'text'  "text"  (backslash escapes)  3  2.5  -1
//   fields       {Field name}  {fldXXXXXXXXXXXXXX}  and a bare single-word
//                name (`Priority = 3`), which Airtable reads as a field too
//   operators    =  !=  <  >  <=  >=  &   (comparison binds looser than &)
//   functions    AND OR NOT TRUE FALSE BLANK RECORD_ID SEARCH FIND LOWER
//                UPPER LEN   (names are case-insensitive)
//
// Anything else -- arithmetic, IF, SWITCH, date functions, an unknown
// function, a syntax error -- is refused as an invalid formula, and a field
// reference that names nothing is refused with the names it could not find.
// Semantics follow Airtable where the subset reaches: a missing cell is BLANK,
// which equals '', 0 and FALSE(); SEARCH is case-insensitive and answers
// blank when it finds nothing, FIND is case-sensitive and answers 0; `=` on
// two strings is exact; a record passes a filter unless its value is 0,
// FALSE, '', BLANK or NaN.
const FUNCS: Record<string, readonly [number, number]> = {
  AND: [1, Number.POSITIVE_INFINITY],
  OR: [1, Number.POSITIVE_INFINITY],
  NOT: [1, 1],
  TRUE: [0, 0],
  FALSE: [0, 0],
  BLANK: [0, 0],
  RECORD_ID: [0, 0],
  SEARCH: [2, 3],
  FIND: [2, 3],
  LOWER: [1, 1],
  UPPER: [1, 1],
  LEN: [1, 1],
}

const COMPARE = new Set(['=', '!=', '<', '>', '<=', '>='])
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' }

function readString(src: string, start: number): [string, number] {
  const quote = src.charAt(start)
  let out = ''
  let i = start + 1
  while (i < src.length) {
    const ch = src.charAt(i)
    if (ch === '\\') {
      const next = src.charAt(i + 1)
      out += ESCAPES[next] ?? next
      i += 2
      continue
    }
    if (ch === quote) return [out, i + 1]
    out += ch
    i += 1
  }
  throw new FormulaSyntaxError('unterminated string')
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src.charAt(i)
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '{') {
      const end = src.indexOf('}', i + 1)
      if (end === -1) throw new FormulaSyntaxError('unterminated field reference')
      out.push({ kind: 'field', text: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (ch === "'" || ch === '"') {
      const [text, next] = readString(src, i)
      out.push({ kind: 'str', text })
      i = next
      continue
    }
    const rest = src.slice(i)
    const num = /^(\d+(\.\d*)?|\.\d+)/.exec(rest)
    if (num !== null) {
      out.push({ kind: 'num', text: num[0] })
      i += num[0].length
      continue
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (ident !== null) {
      out.push({ kind: 'ident', text: ident[0] })
      i += ident[0].length
      continue
    }
    const two = rest.slice(0, 2)
    if (two === '!=' || two === '<=' || two === '>=') {
      out.push({ kind: 'op', text: two })
      i += 2
      continue
    }
    if ('=<>&-'.includes(ch)) {
      out.push({ kind: 'op', text: ch })
      i += 1
      continue
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      out.push({ kind: ch === '(' ? 'lp' : ch === ')' ? 'rp' : 'comma', text: ch })
      i += 1
      continue
    }
    throw new FormulaSyntaxError(`unexpected ${ch}`)
  }
  return out
}

class Parser {
  private at = 0
  private readonly toks: Tok[]

  constructor(toks: Tok[]) {
    this.toks = toks
  }

  parse(): Node {
    if (this.toks.length === 0) throw new FormulaSyntaxError('empty formula')
    const node = this.compare()
    if (this.at !== this.toks.length) throw new FormulaSyntaxError('trailing input')
    return node
  }

  private peek(): Tok | undefined {
    return this.toks[this.at]
  }

  private next(): Tok {
    const tok = this.toks[this.at]
    if (tok === undefined) throw new FormulaSyntaxError('unexpected end')
    this.at += 1
    return tok
  }

  private compare(): Node {
    let left = this.concat()
    for (let tok = this.peek(); tok?.kind === 'op' && COMPARE.has(tok.text); tok = this.peek()) {
      this.at += 1
      left = { kind: 'bin', op: tok.text, left, right: this.concat() }
    }
    return left
  }

  private concat(): Node {
    let left = this.unary()
    for (let tok = this.peek(); tok?.kind === 'op' && tok.text === '&'; tok = this.peek()) {
      this.at += 1
      left = { kind: 'bin', op: '&', left, right: this.unary() }
    }
    return left
  }

  private unary(): Node {
    const tok = this.peek()
    if (tok?.kind === 'op' && tok.text === '-') {
      this.at += 1
      return { kind: 'neg', arg: this.unary() }
    }
    return this.primary()
  }

  private primary(): Node {
    const tok = this.next()
    switch (tok.kind) {
      case 'num':
        return { kind: 'num', value: Number(tok.text) }
      case 'str':
        return { kind: 'str', value: tok.text }
      case 'field':
        return { kind: 'field', ref: tok.text }
      case 'ident':
        return this.peek()?.kind === 'lp' ? this.call(tok.text) : { kind: 'field', ref: tok.text }
      case 'lp': {
        const inner = this.compare()
        if (this.next().kind !== 'rp') throw new FormulaSyntaxError('expected )')
        return inner
      }
      default:
        throw new FormulaSyntaxError(`unexpected ${tok.text}`)
    }
  }

  private call(raw: string): Node {
    const name = raw.toUpperCase()
    const arity = FUNCS[name]
    if (arity === undefined) throw new FormulaSyntaxError(`unknown function ${raw}`)
    this.next()
    const args: Node[] = []
    if (this.peek()?.kind === 'rp') {
      this.next()
    } else {
      for (;;) {
        args.push(this.compare())
        const sep = this.next()
        if (sep.kind === 'rp') break
        if (sep.kind !== 'comma') throw new FormulaSyntaxError('expected , or )')
      }
    }
    if (args.length < arity[0] || args.length > arity[1]) {
      throw new FormulaSyntaxError(`${name} takes ${String(arity[0])}..${String(arity[1])} args`)
    }
    return { kind: 'call', name, args }
  }
}

function refsOf(node: Node, out: string[]): string[] {
  switch (node.kind) {
    case 'field':
      if (!out.includes(node.ref)) out.push(node.ref)
      break
    case 'call':
      for (const arg of node.args) refsOf(arg, out)
      break
    case 'bin':
      refsOf(node.left, out)
      refsOf(node.right, out)
      break
    case 'neg':
      refsOf(node.arg, out)
      break
    default:
      break
  }
  return out
}

export interface Compiled {
  node: Node
  // Each reference as written, resolved to the id of the field it names.
  refs: Map<string, string>
}

// `resolve` answers a field id for a reference, or undefined when it names
// nothing; the refusal then lists every such name, in formula order.
export function compile(src: string, resolve: (ref: string) => string | undefined): Compiled {
  const node = new Parser(tokenize(src)).parse()
  const refs = new Map<string, string>()
  const unknown: string[] = []
  for (const ref of refsOf(node, [])) {
    const id = resolve(ref)
    if (id === undefined) unknown.push(ref)
    else refs.set(ref, id)
  }
  if (unknown.length > 0) throw new UnknownFieldsError(unknown)
  return { node, refs }
}

export interface Env {
  recordId: string
  value: (fieldId: string) => FValue
}

export function toText(v: FValue): string {
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? '1' : '0'
  return typeof v === 'number' ? String(v) : v
}

function numeric(v: FValue): number | null {
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  return v.trim() !== '' && Number.isFinite(n) ? n : null
}

function equal(a: FValue, b: FValue): boolean {
  if (a === null || b === null) {
    const other = a === null ? b : a
    return other === null || other === '' || other === 0 || other === false
  }
  if (typeof a === 'string' && typeof b === 'string') return a === b
  const na = numeric(a)
  const nb = numeric(b)
  if (na !== null && nb !== null) return na === nb
  return toText(a) === toText(b)
}

function order(a: FValue, b: FValue): number {
  const bothText = typeof a === 'string' && typeof b === 'string'
  const na = numeric(a)
  const nb = numeric(b)
  if (!bothText && na !== null && nb !== null) return na - nb
  const ta = toText(a)
  const tb = toText(b)
  return ta < tb ? -1 : ta > tb ? 1 : 0
}

export function truthy(v: FValue): boolean {
  if (v === null || v === false || v === '' || v === 0) return false
  return !(typeof v === 'number' && Number.isNaN(v))
}

function position(needle: FValue, hay: FValue, start: FValue, fold: boolean): number {
  const from = start === null ? 0 : Math.max(0, (numeric(start) ?? 1) - 1)
  const n = fold ? toText(needle).toLowerCase() : toText(needle)
  const h = fold ? toText(hay).toLowerCase() : toText(hay)
  return h.indexOf(n, from)
}

function run(node: Node, env: Env, c: Compiled): FValue {
  switch (node.kind) {
    case 'num':
      return node.value
    case 'str':
      return node.value
    case 'field': {
      const id = c.refs.get(node.ref)
      return id === undefined ? null : env.value(id)
    }
    case 'neg':
      return -(numeric(run(node.arg, env, c)) ?? Number.NaN)
    case 'bin': {
      const l = run(node.left, env, c)
      const r = run(node.right, env, c)
      switch (node.op) {
        case '&':
          return toText(l) + toText(r)
        case '=':
          return equal(l, r)
        case '!=':
          return !equal(l, r)
        case '<':
          return order(l, r) < 0
        case '>':
          return order(l, r) > 0
        case '<=':
          return order(l, r) <= 0
        default:
          return order(l, r) >= 0
      }
    }
    case 'call': {
      const arg = (i: number): FValue => {
        const a = node.args[i]
        return a === undefined ? null : run(a, env, c)
      }
      switch (node.name) {
        case 'AND':
          return node.args.every((a) => truthy(run(a, env, c)))
        case 'OR':
          return node.args.some((a) => truthy(run(a, env, c)))
        case 'NOT':
          return !truthy(arg(0))
        case 'TRUE':
          return true
        case 'FALSE':
          return false
        case 'BLANK':
          return null
        case 'RECORD_ID':
          return env.recordId
        case 'SEARCH': {
          const at = position(arg(0), arg(1), arg(2), true)
          return at === -1 ? null : at + 1
        }
        case 'FIND':
          return position(arg(0), arg(1), arg(2), false) + 1
        case 'LOWER':
          return toText(arg(0)).toLowerCase()
        case 'UPPER':
          return toText(arg(0)).toUpperCase()
        default:
          return Array.from(toText(arg(0))).length
      }
    }
    default:
      return null
  }
}

export function evaluate(c: Compiled, env: Env): FValue {
  return run(c.node, env, c)
}
