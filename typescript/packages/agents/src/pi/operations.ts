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

import { runWithSession } from '@struktoai/mirage-core/context/session_context'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { ExecuteResult, Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent'
import picomatch from 'picomatch'
import { FileVersionTracker } from '../file_version.ts'
import { decode, refusalLine } from '../io_text.ts'

export { StaleMirageFileError } from '../file_version.ts'

export interface MirageOperationsOptions {
  staleWriteProtection?: boolean
  /**
   * The session the operations act as, so its profile judges every
   * call; the workspace's default session when absent.
   */
  sessionId?: string
}

export interface MirageOperationsBundle {
  read: ReadOperations
  write: WriteOperations
  edit: EditOperations
  bash: BashOperations
  grep: GrepOperations
  find: FindOperations
  ls: LsOperations
}

async function ensureParent(ws: Workspace, dir: string): Promise<void> {
  const norm = rstripSlash(dir) || '/'
  if (norm === '/' || (await ws.vfs.exists(norm))) return
  const parent = norm.substring(0, norm.lastIndexOf('/')) || '/'
  await ensureParent(ws, parent)
  try {
    await ws.vfs.mkdir(norm)
  } catch (err) {
    if (await ws.vfs.isDir(norm)) return
    throw err
  }
}

interface WalkOptions {
  ignoreMatchers: ((path: string) => boolean)[]
  limit: number
}

async function walkDirectory(
  ws: Workspace,
  dir: string,
  cwdPrefix: string,
  matcher: (relativePath: string) => boolean,
  opts: WalkOptions,
  results: string[],
): Promise<void> {
  if (results.length >= opts.limit) return
  const entries = await ws.vfs.readdir(dir)
  for (const full of entries) {
    if (results.length >= opts.limit) return
    const rel = full.startsWith(cwdPrefix) ? full.slice(cwdPrefix.length) : full
    if (opts.ignoreMatchers.some((m) => m(rel))) continue
    const isDir = await ws.vfs.isDir(full)
    if (matcher(rel)) results.push(full)
    if (isDir) await walkDirectory(ws, full, cwdPrefix, matcher, opts, results)
  }
}

export function mirageOperations(
  ws: Workspace,
  options: MirageOperationsOptions = {},
): MirageOperationsBundle {
  const versions = new FileVersionTracker(ws, options.staleWriteProtection ?? true)
  const sessionId = options.sessionId
  const asSession = <T>(fn: () => Promise<T>): Promise<T> =>
    sessionId === undefined ? fn() : runWithSession(ws.getSession(sessionId), fn)
  const read: ReadOperations = {
    readFile: (absolutePath: string) => asSession(() => versions.read(absolutePath)),
    access: (absolutePath: string) =>
      asSession(async () => {
        await ws.vfs.stat(absolutePath)
      }),
  }

  const write: WriteOperations = {
    writeFile: (absolutePath: string, content: string) =>
      asSession(() => versions.write(absolutePath, content)),
    mkdir: (dir: string) =>
      asSession(async () => {
        await ensureParent(ws, dir)
        if (!(await ws.vfs.exists(dir))) {
          await ws.vfs.mkdir(dir)
        }
      }),
  }

  const edit: EditOperations = {
    readFile: (absolutePath: string) => asSession(() => versions.readForEdit(absolutePath)),
    writeFile: (absolutePath: string, content: string) =>
      asSession(() => versions.writeEdit(absolutePath, content)),
    access: read.access,
  }

  const bash: BashOperations = {
    exec: async (command, cwd, options) => {
      const timeoutSignal =
        options.timeout !== undefined && options.timeout > 0
          ? AbortSignal.timeout(options.timeout * 1000)
          : undefined
      const signal =
        options.signal !== undefined && timeoutSignal !== undefined
          ? AbortSignal.any([options.signal, timeoutSignal])
          : (options.signal ?? timeoutSignal)
      let result: ExecuteResult
      try {
        result = await ws.shell(command, {
          cwd,
          ...(signal === undefined ? {} : { signal }),
          ...(sessionId === undefined ? {} : { sessionId }),
        })
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw new Error('aborted')
        }
        if (timeoutSignal?.aborted === true) {
          throw new Error('timeout:' + String(options.timeout))
        }
        throw error
      }
      if (result.stdout.length > 0) {
        options.onData(Buffer.from(result.stdout))
      }
      if (result.stderr.length > 0) {
        options.onData(Buffer.from(result.stderr))
      }
      // The record, described once, unless what was just streamed
      // already says why (an operand-scoped refusal's own line).
      const why = refusalLine(decode(result.stdout) + decode(result.stderr), result.refusal)
      if (why.length > 0) options.onData(Buffer.from(why))
      return { exitCode: result.exitCode }
    },
  }

  const grep: GrepOperations = {
    isDirectory: (absolutePath: string) => asSession(() => ws.vfs.isDir(absolutePath)),
    readFile: (absolutePath: string) =>
      asSession(async () => (await versions.read(absolutePath)).toString('utf-8')),
  }

  const find: FindOperations = {
    exists: (absolutePath: string) => asSession(() => ws.vfs.exists(absolutePath)),
    glob: (pattern, cwd, options) =>
      asSession(async () => {
        const matcher = picomatch(pattern, { dot: false })
        const ignoreMatchers = options.ignore.map((p) => picomatch(p, { dot: false }))
        const root = rstripSlash(cwd) || '/'
        const cwdPrefix = root === '/' ? '/' : `${root}/`
        const results: string[] = []
        await walkDirectory(
          ws,
          root,
          cwdPrefix,
          matcher,
          { ignoreMatchers, limit: options.limit },
          results,
        )
        return results
      }),
  }

  const ls: LsOperations = {
    exists: (absolutePath: string) => asSession(() => ws.vfs.exists(absolutePath)),
    stat: (absolutePath: string) =>
      asSession(async () => {
        const isDir = await ws.vfs.isDir(absolutePath)
        return { isDirectory: () => isDir }
      }),
    readdir: (absolutePath: string) =>
      asSession(async () => {
        const entries = await ws.vfs.readdir(absolutePath)
        const prefix = absolutePath === '/' ? '/' : `${rstripSlash(absolutePath)}/`
        return entries.map((e) => (e.startsWith(prefix) ? e.slice(prefix.length) : e))
      }),
  }

  return { read, write, edit, bash, grep, find, ls }
}
