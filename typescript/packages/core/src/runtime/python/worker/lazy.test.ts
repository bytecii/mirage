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

import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'
import { PyodideRuntime } from '../pyodide.ts'
import { PrefixResolver } from '../../resolver.ts'
import { FileStat, FileType, Limit, MountMode } from '../../../types.ts'
import type { BridgeDispatchFn, RunArgs } from '../../types.ts'
import { CommandTimeoutError } from '../../../commands/errors.ts'
import { CLISpec } from '../../../commands/cli/types.ts'
import { ScriptSource } from '../../routing/types.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const runArgs = (code: string): RunArgs => ({ code, args: [], env: {}, stdin: null })

describe('Pyodide lazy VFS', { timeout: 60_000 }, () => {
  it.each(['first', 'bad', 'later'])(
    'counts all writes discarded after %s fails',
    async (rejected) => {
      const names = ['first', 'bad', 'later', 'after', 'last']
      const files = new Map(names.map((name) => [`/data/${name}`, ENC.encode('old')]))
      const writes: string[] = []
      const dispatch: BridgeDispatchFn = async (op, path, bytes) => {
        await Promise.resolve()
        const data = files.get(path)
        if (data === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' })
        if (op === 'stat')
          return new FileStat({ name: path, type: FileType.FILE, size: data.length })
        if (op === 'read') return data
        if (op === 'write') {
          writes.push(path)
          if (path === `/data/${rejected}`) throw new Error('denied')
          files.set(path, bytes ?? new Uint8Array())
          return
        }
        throw new Error(`unexpected op: ${op}`)
      }
      const rt = new PyodideRuntime()
      rt.attach(dispatch, new PrefixResolver(() => ['/data/']))
      try {
        const result = await rt.run(
          runArgs(`
import os
for name in ['first', 'bad', 'later', 'after', 'last']:
    os.stat('/data/' + name)
for name in ['first', 'bad', 'later']:
    with open('/data/' + name, 'w') as f: f.write('new')
try: os.stat('/data/missing')
except OSError: pass
with open('/data/after', 'w') as f: f.write('discarded inline')
try: os.stat('/data/also_missing')
except OSError: pass
with open('/data/last', 'w') as f: f.write('discarded at completion')
`),
        )
        const failedAt = names.indexOf(rejected)
        expect(result.exitCode).toBe(1)
        expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe(
          `python3: failed to write /data/${rejected} on mount: denied\n` +
            `python3: skipped ${String(4 - failedAt)} later mutation(s) after that failure\n`,
        )
        expect(writes).toEqual(names.slice(0, failedAt + 1).map((name) => `/data/${name}`))
        for (const name of names.slice(failedAt))
          expect(DEC.decode(files.get(`/data/${name}`))).toBe('old')
        const next = await rt.run(runArgs("with open('/data/last', 'w') as f: f.write('fresh')"))
        expect(next.exitCode).toBe(0)
        expect(DEC.decode(next.stderr ?? new Uint8Array())).toBe('')
        expect(DEC.decode(files.get('/data/last'))).toBe('fresh')
      } finally {
        await rt.close()
      }
    },
  )

  it.each([false, true])(
    'stops a timed-out script CLI and recovers (warm worker: %s)',
    async (warm) => {
      const rt = new PyodideRuntime()
      const ws = new Workspace(
        { '/data': new RAMResource() },
        { mode: MountMode.EXEC, runtimes: [rt, 'vfs'], shellParser: await getTestParser() },
      )
      ws.registerCli(
        'spin',
        new CLISpec({
          name: 'spin',
          script: new ScriptSource('while True: pass'),
          runtime: 'pyodide',
          limit: new Limit({ timeoutSeconds: 0.1 }),
        }),
      )
      try {
        // Cover both cancellation during startup and an already executing guest.
        if (warm) expect((await ws.execute("python3 -c 'pass'")).exitCode).toBe(0)
        expect((await ws.execute('spin')).exitCode).toBe(124)
        const next = await ws.execute("python3 -c 'print(42)'")
        expect(next.exitCode).toBe(0)
        expect(DEC.decode(next.stdout)).toBe('42\n')
      } finally {
        await ws.close()
      }
    },
  )

  it('does no preload, reads only accessed bytes, and refreshes between sessions', async () => {
    const context = new AsyncLocalStorage<string>()
    const calls: { op: string; path: string; session: string | undefined }[] = []
    let bytes = new Uint8Array(200_000).fill(65)
    const dispatch: BridgeDispatchFn = async (op, path) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      calls.push({ op, path, session: context.getStore() })
      if (path !== '/data/one.bin') throw new Error(`unexpected access: ${op} ${path}`)
      if (op === 'stat')
        return new FileStat({ name: path, type: FileType.FILE, size: bytes.length })
      if (op === 'read') return bytes
      throw new Error(`unexpected op: ${op}`)
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, new PrefixResolver(() => ['/data/', '/huge/']))
    try {
      expect((await rt.run(runArgs('print(1)'))).exitCode).toBe(0)
      expect(calls).toEqual([])
      const first = await context.run('one', () =>
        rt.run(
          runArgs("data = open('/data/one.bin', 'rb').read(); print(len(data), data[0], data[-1])"),
        ),
      )
      expect(DEC.decode(first.stderr ?? new Uint8Array())).toBe('')
      expect(DEC.decode(first.stdout)).toBe('200000 65 65\n')
      expect(calls.every((c) => c.session === 'one')).toBe(true)
      expect(calls.filter((c) => c.op === 'read')).toHaveLength(1)
      calls.length = 0
      bytes = ENC.encode('fresh')
      const second = await context.run('two', () =>
        rt.run(runArgs("print(open('/data/one.bin').read())")),
      )
      expect(DEC.decode(second.stdout)).toBe('fresh\n')
      expect(calls.every((c) => c.session === 'two')).toBe(true)
      expect(calls.some((c) => c.op === 'readdir')).toBe(false)
    } finally {
      await rt.close()
    }
  })

  it('keeps real files at standard stream paths on a /dev mount', async () => {
    const dispatch: BridgeDispatchFn = async (op, path) => {
      await Promise.resolve()
      if (path === '/dev/stdin') {
        if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 4 })
        if (op === 'read') return ENC.encode('real')
      }
      throw Object.assign(new Error(path), { code: 'ENOENT' })
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, new PrefixResolver(() => ['/dev/']))
    try {
      const result = await rt.run(runArgs("print(open('/dev/stdin').read())"))
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('real\n')
    } finally {
      await rt.close()
    }
  })

  it('interrupts compute and a blocked file read, then keeps serving requests', async () => {
    let release: (() => void) | undefined
    const dispatch: BridgeDispatchFn = async (op, path) => {
      if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 4 })
      if (op === 'read') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return ENC.encode('late')
      }
      throw new Error(`unexpected op: ${op}`)
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, new PrefixResolver(() => ['/data/']))
    try {
      await rt.run(runArgs('pass'))
      await expect(
        rt.run({ ...runArgs('while True: pass'), timeoutSeconds: 0.1 }),
      ).rejects.toBeInstanceOf(CommandTimeoutError)
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, 100)
      const aborted = await rt.run({ ...runArgs('while True: pass'), signal: controller.signal })
      clearTimeout(timer)
      expect(aborted.exitCode).toBe(1)
      await expect(
        rt.run({ ...runArgs("open('/data/hang').read()"), timeoutSeconds: 0.1 }),
      ).rejects.toBeInstanceOf(CommandTimeoutError)
      release?.()
      const fresh = await rt.run(runArgs('print(42)'))
      expect(fresh.exitCode).toBe(0)
      expect(DEC.decode(fresh.stdout)).toBe('42\n')
    } finally {
      release?.()
      await rt.close()
    }
  })
})
