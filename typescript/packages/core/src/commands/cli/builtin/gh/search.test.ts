import { describe, expect, it, vi } from 'vitest'
import type { FlagValue } from '../../../spec/types.ts'
import { search } from '../../../../core/github/search.ts'
import { searchSpec } from './search.ts'

vi.mock('../../../../core/github/search.ts', () => ({ search: vi.fn(() => Promise.resolve([])) }))

const cases: [string, Record<string, FlagValue>, string][] = [
  [
    'issues',
    {
      label: ['bug,help wanted'],
      repo: ['integ/a', 'other/b'],
      locked: 'false',
      no_assignee: true,
    },
    '"two words" is:unlocked label:"help wanted" label:bug no:assignee repo:integ/a repo:other/b type:issue',
  ],
  [
    'prs',
    { app: 'bot', review_requested: 'integ/team', merged: 'false', draft: true },
    '"two words" author:app/bot draft:true is:unmerged team-review-requested:integ/team type:pr',
  ],
  [
    'repos',
    { owner: ['integ,other'], include_forks: 'only', number_topics: '>2' },
    '"two words" fork:only topics:>2 user:integ user:other',
  ],
  [
    'code',
    { match: ['file'], extension: 'ts', repo: ['integ/a'] },
    '"two words" extension:ts in:file repo:integ/a',
  ],
  [
    'commits',
    { author_name: 'A Person', merge: 'false', visibility: ['public'] },
    '"two words" author-name:"A Person" is:public merge:false',
  ],
]

describe('search qualifiers match native gh', () => {
  it.each(cases)('%s', async (kind, flags, expected) => {
    const leaf = searchSpec().subcommands.find((item) => item.name === kind)
    if (!leaf?.fn) throw new Error('missing search handler')
    await leaf.fn({
      config: { token: 't' },
      argv: ['search', kind, 'two words'],
      paths: [],
      texts: ['two words'],
      flags: { ...flags, limit: '30', json: 'url' },
      stdin: null,
      env: {},
      spec: leaf,
    })
    expect(vi.mocked(search).mock.lastCall?.[2]).toBe(expected)
  })
})
