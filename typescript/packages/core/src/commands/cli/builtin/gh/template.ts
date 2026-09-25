import { compareCodePoints } from '../../../../utils/sort.ts'
import type { JsonValue as Value } from '../../../../types.ts'
function text(value: Value | undefined): string {
  if (value == null) return '<no value>'
  if (Array.isArray(value)) return `[${value.map(text).join(' ')}]`
  if (typeof value === 'object')
    return `map[${Object.keys(value)
      .sort(compareCodePoints)
      .map((key) => `${key}:${text(value[key])}`)
      .join(' ')}]`
  return String(value)
}
function lookup(token: string, dot: Value, root: Value): Value {
  if (token.startsWith('"')) return JSON.parse(token) as Value
  if (token.startsWith('`')) return token.slice(1, -1)
  if (token === 'true' || token === 'false') return token === 'true'
  if (/^-?\d+$/.test(token)) return Number(token)
  if (token === '.') return dot
  let value = token.startsWith('$') ? root : dot
  for (const key of token
    .replace(/^\$?\.?/, '')
    .split('.')
    .filter(Boolean))
    value =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value[key] ?? null)
        : null
  return value
}
function call(name: string, args: Value[]): Value {
  const a = args[0],
    b = args[1]
  switch (name) {
    case 'len':
      return typeof a === 'string' || Array.isArray(a)
        ? a.length
        : Object.keys(a as Record<string, Value>).length
    case 'join':
      return (b as Value[]).map(text).join(text(a))
    case 'pluck':
      return (b as Record<string, Value>[]).map((row) => row[text(a)] ?? null)
    case 'print':
      return args.map(text).join('')
    case 'println':
      return `${args.map(text).join(' ')}\n`
    case 'printf': {
      let i = 1
      return text(a).replace(/%(%|s|v|d|q|f)/g, (_, flag: string) =>
        flag === '%'
          ? '%'
          : flag === 'q'
            ? JSON.stringify(args[i++])
            : flag === 'f'
              ? Number(args[i++]).toFixed(6)
              : text(args[i++]),
      )
    }
    case 'index': {
      let v = a
      for (const key of args.slice(1))
        v = Array.isArray(v) ? v[Number(key)] : (v as Record<string, Value>)[text(key)]
      return v ?? null
    }
    case 'eq':
      return args.slice(1).some((value) => value === a)
    case 'ne':
      return a !== b
    case 'not':
      return !a
    case 'and':
      return args.every(Boolean)
    case 'or':
      return args.some(Boolean)
    case 'color':
    case 'autocolor':
    case 'hyperlink':
      return args.at(-1) ?? ''
    case 'truncate': {
      const n = Number(a),
        s = text(b)
      return s.length <= n ? s : s.slice(0, Math.max(0, n - 3)) + '.'.repeat(Math.min(n, 3))
    }
    case 'contains':
      return text(b).includes(text(a))
    case 'hasPrefix':
      return text(b).startsWith(text(a))
    case 'hasSuffix':
      return text(b).endsWith(text(a))
    default:
      throw new Error(`template: function "${name}" not defined`)
  }
}
function evaluate(expression: string, dot: Value, root: Value): Value {
  const tokens = expression.match(/"(?:\\.|[^"\\])*"|`[^`]*`|[^\s|]+|\|/g) ?? []
  const parts: string[][] = [[]]
  for (const token of tokens) {
    if (token === '|') parts.push([])
    else parts.at(-1)?.push(token)
  }
  let value: Value = null
  parts.forEach((part, i) => {
    const head = part[0]
    if (head === undefined) throw new Error('template: empty pipeline')
    const args = part.slice(1).map((token) => lookup(token, dot, root))
    if (i > 0) args.push(value)
    value =
      part.length === 1 && i === 0 && (/^[.$"`]/.test(head) || /^(true|false|-?\d+)$/.test(head))
        ? lookup(head, dot, root)
        : call(head, args)
  })
  return value
}

/** Render selected JSON with Go-style actions, pipelines and blocks. */
export function renderTemplate(template: string, value: Value): string {
  const tokens: [string, string][] = []
  let end = 0,
    trim = false
  for (const match of template.matchAll(/{{(-?)\s*(.*?)\s*(-?)}}/gs)) {
    let segment = template.slice(end, match.index)
    if (trim) segment = segment.trimStart()
    if (match[1]) segment = segment.trimEnd()
    tokens.push(['text', segment], ['action', match[2] ?? ''])
    trim = Boolean(match[3])
    end = match.index + match[0].length
  }
  tokens.push(['text', trim ? template.slice(end).trimStart() : template.slice(end)])
  function render(start: number, stop: number, dot: Value): string {
    const output: string[] = []
    for (let i = start; i < stop; ) {
      const [tag, action] = tokens[i++] ?? ['', '']
      if (tag === 'text') {
        output.push(action)
        continue
      }
      const command = action.split(' ')[0] ?? '',
        expression = action.slice(command.length + 1)
      if (['range', 'if', 'with'].includes(command)) {
        let depth = 1,
          cursor = i,
          alternate: number | undefined
        for (; cursor < stop; cursor++) {
          const [nestedTag, nestedAction] = tokens[cursor] ?? ['', '']
          if (nestedTag !== 'action') continue
          const nested = nestedAction.split(' ')[0] ?? ''
          if (['range', 'if', 'with'].includes(nested)) depth++
          else if (nested === 'end') {
            if (--depth === 0) break
          } else if (nested === 'else' && depth === 1) alternate = cursor
        }
        if (depth) throw new Error('template: unexpected EOF')
        const resolved = evaluate(expression, dot, value),
          bodyEnd = alternate ?? cursor
        const truthy = Boolean(resolved) && (!Array.isArray(resolved) || resolved.length > 0)
        if (command === 'range' && truthy) {
          const entries = Array.isArray(resolved)
            ? resolved
            : Object.keys(resolved as Record<string, Value>)
                .sort(compareCodePoints)
                .map((key) => (resolved as Record<string, Value>)[key] ?? null)
          output.push(...entries.map((item) => render(i, bodyEnd, item)))
        } else if (truthy) output.push(render(i, bodyEnd, command === 'with' ? resolved : dot))
        else if (alternate !== undefined) output.push(render(alternate + 1, cursor, dot))
        i = cursor + 1
      } else if (command === 'end' || command === 'else')
        throw new Error(`template: unexpected ${command}`)
      else output.push(text(evaluate(action, dot, value)))
    }
    return output.join('')
  }
  return render(0, tokens.length, value)
}
