import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Workspace } from '@struktoai/mirage-node'
import type { Case, ExecWorkspace } from './types.ts'
import { statCheck } from './execution.ts'

async function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function waitFor<T>(probe: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = performance.now() + 10000
  while (performance.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${description}`)
}
export async function runLifecycle(workspace: ExecWorkspace, c: Case) {
  const ws = workspace as unknown as Workspace
  const directory = await mkdtemp(join(tmpdir(), 'mirage-shell-lifecycle-'))
  const file = join(directory, 'pid')
  const abort = new AbortController()
  let pid: number | undefined
  let run: Promise<unknown> | undefined
  try {
    if (c.lifecycle === 'cancel') {
      run = ws.execute(c.command, {
        signal: abort.signal,
        env: { MIRAGE_PID_FILE: file },
      })
      // Attach immediately, including if readiness fails before the await below.
      void run.catch(() => undefined)
    } else
      await ws.execute(`{ ${c.command}; } &`, {
        env: { MIRAGE_PID_FILE: file },
      })
    pid = await waitFor(async () => {
      try {
        const value = await readFile(file, 'utf8')
        return value ? Number(value) : null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }, 'interpreter PID')
    if (c.lifecycle === 'cancel') {
      abort.abort()
      try {
        await deadline(run!, 'canceled execution')
        throw new Error('execution ignored cancellation')
      } catch (error) {
        if ((error as Error).name !== 'AbortError') throw error
      }
    } else {
      const job = ws.jobTable.get(1)
      if (job === null) throw new Error('missing job')
      if (c.lifecycle === 'close') await deadline(ws.close(), 'workspace close')
      else if ((await ws.execute('kill %1')).exitCode !== 0) throw new Error('kill failed')
      await deadline(job.console.waitFinished(), 'job console finish')
      if (job.status !== 'killed') throw new Error(`job still ${job.status}`)
    }
    await waitFor(async () => (running(pid!) ? null : true), 'interpreter exit')
    return {
      exitCode: 0,
      out: 'started\nstopped\n',
      err: '',
      elapsed: 0,
      checkOut: c.check ? await statCheck(ws, c.check) : null,
    }
  } finally {
    abort.abort()
    // The test owns this PID. Even broken cancellation must not leak a child.
    if (pid !== undefined && running(pid)) process.kill(pid, 'SIGKILL')
    try {
      await deadline(ws.close(), 'workspace cleanup')
      if (run)
        await deadline(
          run.catch(() => undefined),
          'execution cleanup',
        )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
