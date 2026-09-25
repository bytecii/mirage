import { expect, it } from 'vitest'
import type { JsonValue } from '../../../../types.ts'
import { renderTemplate } from './template.ts'

const cases: [string, JsonValue, string][] = [
  [
    '{{range .}}{{if .ok}}{{.name}}{{else}}skip{{end}};{{end}}',
    [
      { ok: true, name: '雪' },
      { ok: false, name: 'x' },
    ],
    '雪;skip;',
  ],
  ['{{range .}}x{{else}}empty{{end}}', [], 'empty'],
  ['{{pluck "name" . | join ", "}}', [{ name: 'one' }, { name: 'two' }], 'one, two'],
  [
    '{{printf "%q %v %f" .name .ok .value}}',
    { name: '雪', ok: true, value: 1.5 },
    '"雪" true 1.500000',
  ],
  ['  {{- with .item -}}{{.name}}{{end}}  ', { item: { name: 'one' } }, 'one  '],
]

it.each(cases)('renders %s', (template, value, expected) => {
  expect(renderTemplate(template, value)).toBe(expected)
})

it('rejects unclosed blocks', () => {
  expect(() => renderTemplate('{{range .}}', [])).toThrow('unexpected EOF')
})
