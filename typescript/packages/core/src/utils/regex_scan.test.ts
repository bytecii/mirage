import { expect, it } from 'vitest'
import { scan, scanMany } from './regex_scan.ts'

it('restarts after empty matches', () => {
  expect(scan('a*|b+', '', false, 'bbb').map((m) => m.index)).toEqual([0, 1, 2, 3])
})

it('preserves captures and first-match mode across a batch', () => {
  const [first, empty] = scanMany('(?<letter>[ab])(x)?', '', false, ['aab', 'none'], false)
  expect(first).toMatchObject([
    { values: ['a', 'a', undefined], index: 0, groups: { letter: 'a' } },
  ])
  expect(empty).toEqual([])
})
