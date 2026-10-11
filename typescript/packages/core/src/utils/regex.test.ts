import { expect, it, vi } from 'vitest'
import { Worker } from '../concurrency/worker.ts'
import { AsyncRegex } from './regex.ts'

it('batches buffered subjects and keeps the invocation worker between files', async () => {
  const worker = new Worker()
  const calls = vi.spyOn(worker, 'call')
  const close = vi.spyOn(worker, 'close')
  try {
    for (let i = 0; i < 2; i++) {
      const pattern = new AsyncRegex(/x/, undefined, true, worker)
      await pattern.prepare('x', () => ['xx', 'no match'])
      await pattern.prepare('xx')
      expect(pattern.matches('xx')).toHaveLength(2)
      expect(pattern.search('no match')).toBeNull()
      await pattern.close()
    }
    expect(calls).toHaveBeenCalledTimes(2)
    expect(close).not.toHaveBeenCalled()
  } finally {
    await worker.close()
  }
})
