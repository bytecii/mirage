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
import { FileStat, FileType } from '../../../types.ts'
import type { BridgeDispatchFn, RunArgs } from '../../types.ts'
import { CommandTimeoutError } from '../../../commands/errors.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const runArgs = (code: string): RunArgs => ({ code, args: [], env: {}, stdin: null })

describe('Pyodide lazy VFS', { timeout: 60_000 }, () => {
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
