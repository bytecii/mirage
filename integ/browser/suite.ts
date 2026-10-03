import { Workspace } from '../../typescript/packages/browser/src/workspace.ts'
import { RAMResource } from '../../typescript/packages/core/src/resource/ram/ram.ts'
import { MountMode } from '../../typescript/packages/core/src/types.ts'
import { JobConsole } from '../../typescript/packages/core/src/shell/console/job_console.ts'
import { Channel } from '../../typescript/packages/core/src/shell/console/types.ts'
import { asyncContextIsolatesTasks } from '../../typescript/packages/core/src/utils/async_context.ts'
import { bindMount, runCase, compare } from '../runners/typescript/execution.ts'
import type { Case, ExecWorkspace } from '../runners/typescript/types.ts'
import concurrency from '../shell/jobs/concurrency.json'
import traps from '../shell/builtins/trap.json'
import commandRun from '../shell/builtins/command/run.json'
import commandFunction from '../shell/builtins/command/function.json'
import commandOperands from '../shell/builtins/command/operands.json'
import substitutionScope from '../shell/expand/cmdsub/scope.json'
import substitutionStatus from '../shell/expand/cmdsub/status.json'

function workspace(): Workspace {
  return new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE, runtimes: ['vfs'] })
}
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

export async function runSuite(): Promise<{ name: string; error?: string }[]> {
  const results: { name: string; error?: string }[] = []
  const tests: [string, (ws: Workspace) => Promise<void>][] = [
    [
      'native browser without Node async context',
      async () => {
        equal(asyncContextIsolatesTasks, false)
      },
    ],
    ...[
      ...concurrency.cases,
      ...traps.cases,
      ...commandRun.cases,
      ...commandFunction.cases,
      ...commandOperands.cases,
      ...substitutionScope.cases,
      ...substitutionStatus.cases,
    ].map(
      (c) =>
        [
          c.id,
          async (ws: Workspace) => {
            const bound = bindMount(c as Case, '/data')
            const result = await runCase(ws as unknown as ExecWorkspace, bound)
            equal(
              compare(
                bound,
                result.exitCode,
                result.out,
                result.err,
                result.elapsed,
                result.checkOut,
              ),
              [],
            )
          },
        ] as [string, (ws: Workspace) => Promise<void>],
    ),
    [
      'background nested evaluation keeps its fork',
      async (ws) => {
        const result = await ws.execute(
          `X=parent; { X=child; eval 'echo "$X"'; echo "$(echo "$X")"; } & wait; echo "$X"`,
        )
        equal(
          [result.exitCode, result.stdoutText, result.stderrText],
          [0, 'child\nchild\nparent\n', ''],
        )
      },
    ],
    [
      'aborted foreground wait leaves background job running',
      async (ws) => {
        await ws.execute('sleep 3600 &')
        const abort = new AbortController()
        const waiting = ws.execute('wait', { signal: abort.signal })
        abort.abort()
        let error: unknown
        try {
          await waiting
        } catch (caught) {
          error = caught
        }
        equal((error as Error)?.name, 'AbortError')
        equal(ws.jobTable.get(1)?.status, 'running')
      },
    ],
    [
      'workspace close settles a running job and its console',
      async (ws) => {
        await ws.execute('echo ready; sleep 3600 &')
        const job = ws.jobTable.get(1)
        if (!job) throw new Error('missing job')
        const finished = job.console.waitFinished()
        await ws.close()
        await finished
        equal(job.status, 'killed')
      },
    ],
    [
      'foreground cancellation stops before its next write',
      async (ws) => {
        const console = new JobConsole()
        const abort = new AbortController()
        const running = ws.execute('echo ready; sleep 3600; echo BAD > /data/cancelled', {
          sink: console,
          signal: abort.signal,
        })
        await console.store.wait(0, AbortSignal.timeout(5000))
        equal(new TextDecoder().decode(await console.snapshot(Channel.STDOUT)), 'ready\n')
        abort.abort()
        try {
          await running
          throw new Error('execution ignored cancellation')
        } catch (error) {
          equal((error as Error).name, 'AbortError')
        }
        equal((await ws.execute('test -e /data/cancelled')).exitCode, 1)
        await console.close()
      },
    ],
  ]
  for (const [name, run] of tests) {
    const ws = workspace()
    try {
      await run(ws)
      results.push({ name })
    } catch (error) {
      results.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await ws.close()
    }
  }
  return results
}
