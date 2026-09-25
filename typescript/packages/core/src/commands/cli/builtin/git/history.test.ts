import { expect, it } from 'vitest'
import { GIT } from './index.ts'
import { parseFlags } from './history.ts'
import { parseCommand, parseToKwargs } from '../../../spec/parser.ts'
import { FlagView } from '../../../spec/flag_view.ts'

it.each([
  [['--date-order', '--topo-order'], 'topo'],
  [['--topo-order', '--date-order'], 'date'],
  [['--topo-order', '--date-order', '--topo-order'], 'topo'],
  [['--graph', '--date-order', '--topo-order'], 'topo'],
  [['--date-order', '--graph'], 'date'],
  [['-S', '--topo-order', '--date-order'], 'date'],
])('honors the last ordering option in %j', (argv, expected) => {
  const spec = GIT.subcommands.find((node) => node.name === 'log')
  if (spec === undefined) throw new Error('missing log spec')
  const parsed = parseCommand(spec, argv, '/')
  expect(parseFlags(new FlagView(parseToKwargs(parsed))).order).toBe(expected)
})
