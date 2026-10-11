import { Worker as NodeWorker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { Worker } from './worker.ts'

describe('computation worker', () => {
  it('serializes calls and recovers after a computation fails', async () => {
    const worker = new Worker()
    try {
      expect(
        await Promise.all([
          worker.call(new URL('node:path'), 'basename', ['/a/b']),
          worker.call(new URL('node:path'), 'join', ['a', 'b']),
        ]),
      ).toEqual(['b', 'a/b'])
      await expect(worker.call(new URL('node:path'), 'basename', [1])).rejects.toThrow()
      expect(await worker.call(new URL('node:path'), 'basename', ['/a/c'])).toBe('c')
    } finally {
      await worker.close()
    }
  })

  it('terminates and joins a worker blocked in synchronous computation', async () => {
    const termination = vi.spyOn(NodeWorker.prototype, 'terminate')
    const worker = new Worker()
    const controller = new AbortController()
    try {
      await worker.call(new URL('node:path'), 'basename', ['/ready'])
      const task = worker.call(
        new URL(
          'data:text/javascript,' +
            encodeURIComponent('export function block() { while (true) {} }'),
        ),
        'block',
        [],
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
