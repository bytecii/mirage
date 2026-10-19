import type { PathSpec } from '../types.ts'

export type ProcessState = 'running' | 'stopping' | 'exited'

/** A managed runner, not an OS process or a shell job number. */
export interface ProcessInfo {
  readonly pid: number
  readonly sessionId: string
  readonly command: string
  readonly cwd: PathSpec
  readonly startedAt: number
  readonly executionId: string
  readonly state: ProcessState
  readonly cancellationRequested: boolean
  readonly exitCode: number | null
  readonly failure: string | null
  readonly parentPid: number | null
  readonly groupId: number
}

export type ProcessRunner = () => Promise<number>

/**
 * Runs a runner as part of its execution, so what it records names it. The
 * workspace hands over the caller's binder: the process layer sits below
 * the session the caller carries, so it cannot import it.
 */
export type ExecutionBind = <T>(executionId: string, run: () => Promise<T>) => Promise<T>

export interface SpawnRequest {
  readonly argv: readonly string[]
  readonly cwd?: PathSpec
  readonly env?: Readonly<Record<string, string>>
  readonly replaceEnv?: boolean
  readonly mergeStderr?: boolean
}
