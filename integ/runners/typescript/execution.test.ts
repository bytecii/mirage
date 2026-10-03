import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runCase, validateConcurrent } from './execution.ts'
import type { ExecWorkspace, ExecutionCase } from './types.ts'

function concurrentCase(): ExecutionCase {
  const worker = {
    command: 'worker',
    expect: { exit: 0, stdout: '', stderr: '' },
  }
  return {
    command: 'joined',
    concurrent: [worker, { ...worker }],
    expect: worker.expect,
  }
}
function workspace(execute: ExecWorkspace['execute']): ExecWorkspace {
  return { execute } as ExecWorkspace
}
const success = {
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
}

test('workers overlap before the join', { timeout: 1000 }, async () => {
  let started = 0
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const ws = workspace(async (command) => {
    if (command === 'worker') {
      if (++started === 2) release()
      await ready
    } else assert.equal(started, 2)
    return success
  })
  assert.equal((await runCase(ws, concurrentCase())).exitCode, 0)
})

test('worker failures cannot be hidden by the join', async () => {
  const ws = workspace(async (command) => {
    assert.equal(command, 'worker')
    return { ...success, exitCode: 7 }
  })
  const result = await runCase(ws, concurrentCase())
  assert.equal(result.exitCode, 1)
  assert.match(result.err, /concurrent\[0\]: exit: expected 0, got 7/)
})

test('timeout cancels and joins workers', { timeout: 1000 }, async () => {
  let cleaned = 0
  const ws = workspace(async (_command, options) => {
    try {
      await new Promise<never>((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      })
      return success
    } finally {
      cleaned++
    }
  })
  await assert.rejects(runCase(ws, { ...concurrentCase(), timeout_seconds: 0.01 }), /aborted/)
  assert.equal(cleaned, 2)
})

test('empty concurrency groups are refused', () => {
  assert.throws(() => validateConcurrent({ ...concurrentCase(), concurrent: [] }), /at least two/)
})
