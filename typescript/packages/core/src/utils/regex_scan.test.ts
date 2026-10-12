import { expect, it } from 'vitest'
import { scan } from './regex_scan.ts'

it('restarts after empty matches', () => {
  expect(scan('a*|b+', '', false, 'bbb').map((m) => m.index)).toEqual([0, 1, 2, 3])
})

it('keeps captures in first-match mode', () => {
  expect(scan('(?<letter>[ab])(x)?', '', false, 'aab', false)).toMatchObject([
    { values: ['a', 'a', undefined], index: 0, groups: { letter: 'a' } },
  ])
  expect(scan('(?<letter>[ab])(x)?', '', false, 'none', false)).toEqual([])
})
