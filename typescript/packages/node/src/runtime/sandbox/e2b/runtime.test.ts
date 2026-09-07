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

import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import { beforeEach, describe, expect, it } from 'vitest'
import { E2BRuntime, type E2bSdk } from './runtime.ts'

const DEC = new TextDecoder()

class FakeExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`exit ${String(exitCode)}`)
  }
}
class FakeNotFoundError extends Error {}

class FakeHandle {
  input: Uint8Array = new Uint8Array()
  disconnected = false
  killed = false
  inputError: Error | null = null
  constructor(
    readonly command: string,
    public eof: boolean,
  ) {}

  sendStdin(data: Uint8Array): Promise<void> {
    if (this.inputError) return Promise.reject(this.inputError)
    this.input = data
    return Promise.resolve()
  }
  closeStdin(): Promise<void> {
    this.eof = true
    return Promise.resolve()
  }
  wait() {
    if (this.command === 'exit 3')
      return Promise.reject(new FakeExitError(3, 'partial', 'boom-err'))
    expect(this.eof).toBe(true)
    return Promise.resolve({
      stdout: Buffer.from(this.input).toString('hex'),
      stderr: 'warn',
      exitCode: 0,
    })
  }
  kill(): Promise<boolean> {
    this.killed = true
    return Promise.resolve(true)
  }
  disconnect(): Promise<void> {
    this.disconnected = true
    return Promise.resolve()
  }
}

class FakeCommands {
  calls: [string, Record<string, string>, string, boolean][] = []
  handles: FakeHandle[] = []
  inputError: Error | null = null
  run(
    command: string,
    opts: { envs: Record<string, string>; cwd: string; background: boolean; stdin: boolean },
  ) {
    expect(opts.background).toBe(true)
    this.calls.push([command, opts.envs, opts.cwd, opts.stdin])
    const handle = new FakeHandle(command, !opts.stdin)
    handle.inputError = this.inputError
    this.handles.push(handle)
    return Promise.resolve(handle)
  }
}

class FakeSandbox {
  static connected: [string, Record<string, unknown>][] = []
  static last: FakeSandbox
  readonly commands = new FakeCommands()
  static async connect(sandboxId: string, params: Record<string, unknown>): Promise<FakeSandbox> {
    FakeSandbox.connected.push([sandboxId, params])
    await Promise.resolve()
    FakeSandbox.last = new FakeSandbox()
    return FakeSandbox.last
  }
}

class FakedE2BRuntime extends E2BRuntime {
  protected override loadSdk(): Promise<E2bSdk> {
    return Promise.resolve({
      Sandbox: FakeSandbox,
      CommandExitError: FakeExitError,
      NotFoundError: FakeNotFoundError,
    } as unknown as E2bSdk)
  }
}

function makeRuntime() {
  return new FakedE2BRuntime({ config: { sandboxId: 'sb-live' } })
}

beforeEach(() => {
  FakeSandbox.connected = []
})

describe('E2BRuntime', () => {
  it('connects by sandbox id with api key', async () => {
    const runtime = new FakedE2BRuntime({ config: { sandboxId: 'sb-live', apiKey: 'k-123' } })
    await runtime.connect()
    expect(FakeSandbox.connected).toEqual([['sb-live', { apiKey: 'k-123' }]])
  })
  it('requires a sandbox id', () => {
    expect(() => new FakedE2BRuntime({ config: {} })).toThrow('sandboxId')
  })
  it.each([
    null,
    new Uint8Array(),
    new TextEncoder().encode('a\nb\n'),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  ])('preserves native input, EOF and the command: %s', async (data) => {
    const runtime = makeRuntime()
    const result = await runtime.runLine('wc -l | cat', data, { E: '1' }, '/workspace')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe(Buffer.from(data ?? []).toString('hex'))
    expect(DEC.decode(result.stderr)).toBe('warn')
    expect(FakeSandbox.last.commands.calls).toEqual([
      ['wc -l | cat', { E: '1' }, '/workspace', data !== null],
    ])
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({
      eof: true,
      disconnected: true,
      killed: false,
    })
  })
  it.each([false, true])(
    'preserves a nonzero exit when stdin races exit: %s',
    async (earlyExit) => {
      const runtime = makeRuntime()
      await runtime.connect()
      if (earlyExit) FakeSandbox.last.commands.inputError = new FakeNotFoundError('process exited')
      const result = await runtime.execLine(
        'exit 3',
        new TextEncoder().encode('input'),
        {},
        '/workspace',
      )
      expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
        3,
        'partial',
        'boom-err',
      ])
      expect(FakeSandbox.last.commands.handles[0]).toMatchObject({
        disconnected: true,
        killed: false,
      })
    },
  )
  it('connects once and keeps parallel input separate', async () => {
    const runtime = makeRuntime()
    const payloads = Array.from({ length: 6 }, (_, i) => new Uint8Array(100).fill(i))
    const results = await Promise.all(
      payloads.map((data) => runtime.runLine('cat', data, {}, '/workspace')),
    )
    expect(FakeSandbox.connected).toHaveLength(1)
    expect(results.map((r) => DEC.decode(r.stdout))).toEqual(
      payloads.map((data) => Buffer.from(data).toString('hex')),
    )
    expect(FakeSandbox.last.commands.handles.every((h) => h.disconnected)).toBe(true)
  })
  it('kills its command and disconnects when sending stdin fails', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    FakeSandbox.last.commands.inputError = new Error('stdin transport failed')
    await expect(runtime.execLine('cat', new Uint8Array([1]), {}, '/workspace')).rejects.toThrow(
      'stdin transport failed',
    )
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({ killed: true, disconnected: true })
  })
  it('registers under e2b', () => {
    const runtime = buildRuntime('e2b', { config: { sandboxId: 'sb-live' } })
    expect(runtime).toBeInstanceOf(E2BRuntime)
    expect(runtime.captures).toEqual(['*'])
  })
})
