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

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RAMResource } from '../../resource/ram/ram.ts'
import { Channel } from '../../shell/console/index.ts'
import { JobStatus } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/types.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

const DEC = new TextDecoder()

let parser: ShellParser

beforeAll(async () => {
  parser = await getTestParser()
})

const workspaces: Workspace[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((ws) => ws.close()))
})

function buildWs(): Workspace {
  const workspace = new Workspace(
    { '/m': [new RAMResource(), MountMode.WRITE] },
    { mode: MountMode.WRITE, shellParser: parser },
  )
  workspaces.push(workspace)
  return workspace
}

/** Run a backgrounded command and return its finished console. */
async function runBg(cmd: string): Promise<{ out: string; err: string }> {
  const ws = buildWs()
  try {
    await ws.execute(cmd)
    await ws.jobTable.wait(1)
    const job = ws.jobTable.get(1)
    if (job === null) throw new Error('job 1 missing')
    return {
      out: DEC.decode(await job.console.snapshot(Channel.STDOUT)),
      err: DEC.decode(await job.console.snapshot(Channel.STDERR)),
    }
  } finally {
    await ws.close()
  }
}

describe('streaming: output lands while the job is still running', () => {
  it('streams before the job finishes', async () => {
    const ws = buildWs()
    await ws.execute('for i in 1 2; do echo $i; sleep 3600; done &')
    const job = ws.jobTable.get(1)
    if (job === null) throw new Error('job 1 missing')
    await job.console.store.wait(0, AbortSignal.timeout(2000))
    expect(job.status).toBe(JobStatus.RUNNING)
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).toBe('1\n')
  })
})

describe('capture sites: a sink must never leak into a captured value', () => {
  it('sends redirected output to the file, not the console', async () => {
    const ws = buildWs()
    await ws.execute('echo hi > /m/f.txt &')
    await ws.jobTable.wait(1)
    const job = ws.jobTable.get(1)
    if (job === null) throw new Error('job 1 missing')
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).toBe('')
    const res = await ws.execute('cat /m/f.txt')
    expect(res.stdoutText).toBe('hi\n')
  })

  it('routes stderr to its own channel', async () => {
    const { out, err } = await runBg('echo err >&2 &')
    expect(out).toBe('')
    expect(err).toBe('err\n')
  })
})

describe('kill reaches a real running command', () => {
  it('stops a job that is already mid-flight, not one still queued', async () => {
    const ws = buildWs()
    // Grouped, so `&` backgrounds the whole sequence rather than only
    // the last command.
    await ws.execute('(echo started; sleep 10; echo never) &')
    const job = ws.jobTable.get(1)
    if (job === null) throw new Error('job 1 missing')

    // Wait until the job is genuinely inside the long command. Killing
    // before it starts would pass on the entry check alone and prove
    // nothing about aborting work in progress.
    await job.console.store.wait(0, AbortSignal.timeout(3000))

    const started = Date.now()
    await ws.execute('kill %1')
    const elapsed = Date.now() - started

    expect(job.status).toBe(JobStatus.KILLED)
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).not.toContain('never')
    // Without a signal reaching the executor this waits the full 10s
    // for `sleep` to finish on its own.
    expect(elapsed).toBeLessThan(3000)
  })
})

describe('background stdin', () => {
  it('leaves stdin for the foreground command', async () => {
    const ws = buildWs()
    ws.getSession(ws.defaultSessionId).cwd = '/m'
    const result = await ws.execute('sleep 0 & cat', {
      stdin: new TextEncoder().encode('hello\n'),
    })
    expect(result.stdoutText).toBe('hello\n')
  })
})
