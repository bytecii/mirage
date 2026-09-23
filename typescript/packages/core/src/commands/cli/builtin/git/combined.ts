import { getOpcodes } from '../../../builtin/diff_format.ts'
import { DiffOpTag } from '../../../builtin/diff_types.ts'

export function combinedLines(parents: string[][], result: string[], dense: boolean): string[] {
  // Align parents to the result once; each prefix column describes one parent.
  const count = parents.length
  const masks = result.map(() => Array<string>(count).fill('+'))
  const deleted: [string, number][][] = Array.from({ length: result.length + 1 }, () => [])
  parents.forEach((old, parent) => {
    for (const [tag, i, end, j, stop] of getOpcodes(old, result)) {
      if (tag === DiffOpTag.EQUAL) {
        for (let at = j; at < stop; at++) {
          const mask = masks[at]
          if (mask) mask[parent] = ' '
        }
      } else for (const line of old.slice(i, end)) deleted[j]?.push([line, parent])
    }
  })
  const rows: { line: string; consumed: number[]; added: number }[] = []
  for (let at = 0; at <= result.length; at++) {
    const grouped: { text: string; prefix: string[] }[] = []
    for (const [line, parent] of deleted[at] ?? []) {
      let match = grouped.find((g) => g.text === line && g.prefix[parent] === ' ')
      if (!match) {
        match = { text: line, prefix: Array<string>(count).fill(' ') }
        grouped.push(match)
      }
      match.prefix[parent] = '-'
    }
    for (const { text, prefix } of grouped)
      rows.push({
        line: prefix.join('') + text,
        consumed: prefix.map((c) => Number(c === '-')),
        added: 0,
      })
    if (at < result.length)
      rows.push({
        line: (masks[at] ?? []).join('') + (result[at] ?? ''),
        consumed: (masks[at] ?? []).map((c) => Number(c === ' ')),
        added: 1,
      })
  }
  const groups: [number, number][] = []
  rows.forEach((row, at) => {
    if (row.line.slice(0, count) === ' '.repeat(count)) return
    const start = Math.max(0, at - 3),
      end = Math.min(rows.length, at + 4),
      last = groups.at(-1)
    if (last && start <= last[1]) last[1] = end
    else groups.push([start, end])
  })
  const output: string[] = []
  for (const [start, end] of groups) {
    const block = rows.slice(start, end)
    if (dense && parents.some((_, p) => block.every((row) => row.line[p] === ' '))) continue
    const ranges: string[] = []
    for (let p = 0; p < count; p++) {
      const offset = rows.slice(0, start).reduce((n, r) => n + (r.consumed[p] ?? 0), 0),
        length = block.reduce((n, r) => n + (r.consumed[p] ?? 0), 0)
      ranges.push(`-${String(offset + Number(length > 0))},${String(length)}`)
    }
    const offset = rows.slice(0, start).reduce((n, r) => n + r.added, 0),
      length = block.reduce((n, r) => n + r.added, 0)
    ranges.push(`+${String(offset + Number(length > 0))},${String(length)}`)
    const marker = '@'.repeat(count + 1)
    output.push(
      `${marker} ${ranges.join(' ')} ${marker}\n`,
      ...block.map((r) => (r.line.endsWith('\n') ? r.line : r.line + '\n')),
    )
  }
  return output
}
