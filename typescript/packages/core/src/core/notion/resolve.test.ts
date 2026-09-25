import { expect, it } from 'vitest'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

const doors = [
  [stat, ''],
  [stat, '/page.json'],
  [readdir, ''],
  [read, '/page.json'],
  [stat, '/Child__child'],
  [read, '/Child__child/page.json'],
  [readdir, '/Child__child'],
] as const

it.each(['title', 'parent', 'trash', 'archived'])(
  'validates a row at every door: %s',
  async (change) => {
    for (const [operation, suffix] of doors) {
      const calls: string[] = []
      const accessor = {
        transport: {
          callTool: (name: string, args: Record<string, unknown>) => {
            calls.push(name)
            expect(args.page_id).toBe('row')
            return Promise.resolve({
              id: 'row',
              properties: { Name: { type: 'title', title: [{ plain_text: 'Row' }] } },
              parent: { data_source_id: change === 'parent' ? 'other' : 'ds' },
              in_trash: change === 'trash',
              archived: change === 'archived',
            })
          },
        },
      }
      const label = change === 'title' ? 'Wrong' : 'Row'
      const virtual = `/databases/DB__db/DS__ds/${label}__row${suffix}`
      const path = new PathSpec({ virtual, directory: virtual, vfsPath: virtual })
      const index = new RAMIndexCacheStore()
      await index.setDir(virtual, [])
      await expect(operation(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(calls).toEqual(['API-retrieve-a-page'])
    }
  },
)

it('keeps the containing row identity when reading a child', async () => {
  const pages: unknown[] = []
  const accessor = {
    transport: {
      callTool: (name: string, args: Record<string, unknown>) => {
        if (name === 'API-retrieve-block-children')
          return Promise.resolve({ results: [], has_more: false, next_cursor: null })
        pages.push(args.page_id)
        return Promise.resolve(
          args.page_id === 'row'
            ? {
                id: 'row',
                parent: { data_source_id: 'ds' },
                properties: { Name: { type: 'title', title: [{ plain_text: 'Row' }] } },
              }
            : { id: 'child' },
        )
      },
    },
  }
  const path = PathSpec.fromStrPath('/databases/DB__db/DS__ds/Row__row/Child__child/page.json')
  await read(accessor, path, undefined)
  expect(pages).toEqual(['row', 'child'])
})
