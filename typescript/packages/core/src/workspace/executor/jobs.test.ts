// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { IOResult } from '../../io/types.ts'
import { Channel, JobConsole, RAMConsoleStore } from '../../shell/console/index.ts'
import { type JobResult, type JobRunner, JobStatus, JobTable } from '../../shell/job_table/index.ts'
import { ExecutionNode } from '../types.ts'
import { handleFg, handleJobs, handleKill, handlePs, handleWait } from './jobs.ts'

/** A runner that finishes immediately with no output. */
const quiet: JobRunner = () => Promise.resolve([new IOResult(), new ExecutionNode()] as JobResult)

/** A runner that never finishes on its own; only an abort ends it. */
function pendingRun(abort: AbortController): JobRunner {
  return async () => {
    await new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
    throw new Error('unreachable')
  }
}

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

describe('handleWait', () => {
  it('waits for all jobs when no id given', async () => {
    const jt = new JobTable()
    jt.submit({
      command: 'a',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const [, io, exec] = await handleWait(jt, ['wait'])
    expect(io.exitCode).toBe(0)
    expect(exec.command).toBe('wait')
    // Bare `wait` reaps, so nothing is left to wait on afterwards.
    expect(jt.listJobs()).toHaveLength(0)
  })

  it('rejects non-numeric job id', async () => {
    const jt = new JobTable()
    const [, io] = await handleWait(jt, ['wait', 'abc'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/not a pid or valid job spec/)
  })

  it('rejects unknown job id', async () => {
    const jt = new JobTable()
    const [, io] = await handleWait(jt, ['wait', '999'])
    expect(io.exitCode).toBe(127)
    expect(decode(io.stderr as Uint8Array)).toMatch(/not a child of this shell/)
  })

  it('awaits a specific job and returns its output and exit code', async () => {
    const jt = new JobTable()
    const run: JobRunner = async (job) => {
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('out'))
      await job.console.emit(Channel.STDERR, new TextEncoder().encode('done'))
      return [new IOResult({ exitCode: 3 }), new ExecutionNode({ command: 'foo', exitCode: 3 })]
    }
    const j = jt.submit({ command: 'foo', run, abort: new AbortController(), cwd: '/' })
    const [resStdout, resIo] = await handleWait(jt, ['wait', j.id.toString()])
    expect(resStdout).toEqual(new TextEncoder().encode('out'))
    expect(resIo.exitCode).toBe(3)
    expect(decode(resIo.stderr as Uint8Array)).toBe('done')
  })

  it('accepts %N job id syntax', async () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const [, io] = await handleWait(jt, ['wait', `%${j.id.toString()}`])
    expect(io.exitCode).toBe(0)
  })
})

describe('handleKill', () => {
  it('rejects missing job id arg', async () => {
    const jt = new JobTable()
    const [, io] = await handleKill(jt, ['kill'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/usage/)
  })

  it('rejects non-numeric job id', async () => {
    const jt = new JobTable()
    const [, io] = await handleKill(jt, ['kill', 'abc'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/invalid job id/)
  })

  it('rejects unknown job id', async () => {
    const jt = new JobTable()
    const [, io] = await handleKill(jt, ['kill', '999'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/no such job/)
  })

  it('kills a known job and returns 0', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const task = pendingRun(abort)
    const j = jt.submit({ command: 'sleep', run: task, abort, cwd: '/' })
    const [, io] = await handleKill(jt, ['kill', j.id.toString()])
    expect(io.exitCode).toBe(0)
    expect(jt.get(j.id)?.status).toBe(JobStatus.KILLED)
  })
})

describe('handleJobs', () => {
  it('returns empty output when no jobs', () => {
    const jt = new JobTable()
    const [out, io] = handleJobs(jt, ['jobs'])
    expect((out as Uint8Array).byteLength).toBe(0)
    expect(io.exitCode).toBe(0)
  })

  it('lists jobs with id, status, command', async () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const abort = new AbortController()
    const task = pendingRun(abort)
    jt.submit({ command: 'bar', run: task, abort, cwd: '/' })
    await jt.wait(j.id)
    const [out] = handleJobs(jt, ['jobs'])
    const text = decode(out as Uint8Array)
    expect(text).toMatch(/\[1\] completed foo/)
    expect(text).toMatch(/\[2\] running bar/)
  })

  it('removes completed jobs from the table', async () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    await jt.wait(j.id)
    handleJobs(jt, ['jobs'])
    expect(jt.listJobs()).toHaveLength(0)
  })
})

describe('handlePs', () => {
  it('lists only running jobs', () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const task = pendingRun(abort)
    jt.submit({ command: 'sleep', run: task, abort, cwd: '/' })
    const [out] = handlePs(jt, ['ps'])
    expect(decode(out as Uint8Array)).toMatch(/1\tsleep/)
  })

  it('returns empty output when no running jobs', () => {
    const jt = new JobTable()
    const [out] = handlePs(jt, ['ps'])
    expect((out as Uint8Array).byteLength).toBe(0)
  })
})

/** Tracks outstanding reads without depending on timers or job completion. */
class TrackedStore extends RAMConsoleStore {
  active = 0
  private began!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.began = resolve
  })

  override async wait(seq: number, signal?: AbortSignal): Promise<void> {
    this.active += 1
    this.began()
    try {
      await super.wait(seq, signal)
    } finally {
      this.active -= 1
    }
  }
}

describe('job wait cancellation', () => {
  it.each(['wait', 'wait -n', 'fg'])(
    '%s releases its readers without killing jobs',
    async (command) => {
      const stores: TrackedStore[] = []
      const table = new JobTable(() => {
        const store = new TrackedStore()
        stores.push(store)
        return new JobConsole(store)
      })
      const abort = new AbortController()
      const job = table.submit({ command: 'pending', run: pendingRun(abort), abort, cwd: '/' })
      const reader = new AbortController()
      const handler = command === 'fg' ? handleFg : handleWait
      const waiting = handler(table, command.split(' '), null, null, reader.signal)
      const store = stores[0]
      if (store === undefined) throw new Error('missing console')
      await store.started
      reader.abort()
      try {
        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
        expect(store.active).toBe(0)
        expect(job.status).toBe(JobStatus.RUNNING)
      } finally {
        await table.killAll()
      }
    },
  )

  it('wait -n releases losing readers and leaves their jobs running', async () => {
    const stores: TrackedStore[] = []
    const table = new JobTable(() => {
      const store = new TrackedStore()
      stores.push(store)
      return new JobConsole(store)
    })
    const jobs = [1, 2].map(() => {
      const abort = new AbortController()
      return table.submit({ command: 'pending', run: pendingRun(abort), abort, cwd: '/' })
    })
    const waiting = handleWait(table, ['wait', '-n'])
    await Promise.all(stores.map((store) => store.started))
    const [first, second] = jobs
    if (first === undefined || second === undefined) throw new Error('missing jobs')
    await table.kill(first.id)
    try {
      const [, result] = await waiting
      expect(result.exitCode).toBe(137)
      expect(stores.map((store) => store.active)).toEqual([0, 0])
      expect(second.status).toBe(JobStatus.RUNNING)
    } finally {
      await table.killAll()
    }
  })
})
