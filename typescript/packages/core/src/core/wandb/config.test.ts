import { describe, expect, it } from 'vitest'
import { normalizeWandbConfig, redactWandbConfig } from './config.ts'
describe('W&B config', () => {
  it.each([
    { entities: [] },
    { entities: ['a/b'] },
    { entities: ['a'], page_size: 0 },
    { entities: ['a'], max_pages: 0 },
    { entities: ['a'], typo: true },
  ])('refuses invalid config %j', (input) => {
    expect(() => normalizeWandbConfig(input)).toThrow()
  })
  it('normalizes snake_case and redacts credentials', () => {
    const config = normalizeWandbConfig({ entities: ['lab'], api_key: 'private-key', page_size: 2 })
    expect(config.pageSize).toBe(2)
    expect(JSON.stringify(redactWandbConfig(config))).not.toContain('private-key')
  })
})
