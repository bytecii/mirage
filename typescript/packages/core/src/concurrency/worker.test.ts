import { Worker as NodeWorker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { Worker } from './worker.ts'

describe('computation worker', () => {
  it('serializes calls and recovers after a computation fails', async () => {
    const worker = new Worker()
    try {
      expect(
        await Promise.all([
          worker.call('scan', ['a', '', false, 'abc']),
          worker.call('scan', ['b', '', false, 'abc']),
        ]),
      ).toMatchObject([[{ values: ['a'], index: 0 }], [{ values: ['b'], index: 1 }]])
      await expect(worker.call('scan', ['[', '', false, 'abc'])).rejects.toThrow()
      expect(await worker.call('scan', ['c', '', false, 'abc'])).toMatchObject([
        { values: ['c'], index: 2 },
      ])
    } finally {
      await worker.close()
    }
  })

  it('terminates and joins a worker blocked in synchronous computation', async () => {
    const termination = vi.spyOn(NodeWorker.prototype, 'terminate')
    const worker = new Worker()
    const controller = new AbortController()
    try {
      await worker.call('scan', ['a', '', false, 'a'])
      const task = worker.call(
        'scan',
        ['^(a+)+$', '', false, 'a'.repeat(80) + '!'],
        controller.signal,
      )
      const refused = expect(task).rejects.toMatchObject({ name: 'AbortError' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      controller.abort()
      await refused
      expect(termination).toHaveBeenCalledOnce()
      expect(termination.mock.settledResults[0]?.type).toBe('fulfilled')
    } finally {
      controller.abort()
      await worker.close()
      termination.mockRestore()
    }
  }, 5000)
})
