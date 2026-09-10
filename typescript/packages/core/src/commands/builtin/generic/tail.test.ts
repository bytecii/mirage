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
import type { IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { tailGeneric } from './tail.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: '/d',
    resolved: true,
    resourcePath: mountKey(path, ''),
  })
}

function opts(flags: Record<string, string | boolean>, signal?: AbortSignal): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null,
    signal,
  } as unknown as CommandOpts
}

// A fake mount whose files the test grows between polls.
class Growing {
  constructor(readonly data: Map<string, Uint8Array>) {}
  stat = (p: PathSpec): Promise<FileStat> => {
    const data = this.data.get(p.virtual)
    if (data === undefined) {
      const err = new Error('ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      return Promise.reject(err)
    }
    return Promise.resolve(
      new FileStat({
        name: p.virtual.split('/').pop() ?? '',
        size: data.byteLength,
        type: FileType.FILE,
      }),
    )
  }
  stream = async function* (this: Growing, p: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield this.data.get(p.virtual) ?? new Uint8Array()
  }.bind(this)
  readRange = (p: PathSpec, offset: number, size: number): Promise<Uint8Array> =>
    Promise.resolve((this.data.get(p.virtual) ?? new Uint8Array()).slice(offset, offset + size))
  set(path: string, text: string): void {
    this.data.set(path, ENC.encode(text))
  }
  append(path: string, text: string): void {
    const prior = this.data.get(path) ?? new Uint8Array()
    const added = ENC.encode(text)
    const out = new Uint8Array(prior.byteLength + added.byteLength)
    out.set(prior, 0)
    out.set(added, prior.byteLength)
    this.data.set(path, out)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function drainFor(
  source: AsyncIterable<Uint8Array>,
  ms: number,
  abort: AbortController,
): Promise<string> {
  const chunks: Uint8Array[] = []
  const drain = (async () => {
    for await (const chunk of source) chunks.push(chunk)
  })()
  await sleep(ms)
  abort.abort()
  await drain
  return chunks.map((c) => DEC.decode(c)).join('')
}

function followOpts(
  abort: AbortController,
  extra: Record<string, string | boolean> = {},
): CommandOpts {
  return opts({ follow: true, sleep_interval: '0.02', ...extra }, abort.signal)
}

describe('tail -f', () => {
  it('prints what a file gains and notes truncation', async () => {
    const fs = new Growing(new Map())
    fs.set('/d/log', 'l1\nl2\n')
    const abort = new AbortController()
    const result = await tailGeneric(
      [spec('/d/log')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )
    const [stream, io] = result as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.append('/d/log', 'l3\n')
      await sleep(60)
      fs.set('/d/log', 'z\n')
      await sleep(60)
      fs.append('/d/log', 'y\n')
    })()
    const text = await drainFor(stream, 350, abort)
    await grower
    expect(text).toBe('l1\nl2\nl3\nz\ny\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('tail: /d/log: file truncated\n')
    expect(io.exitCode).toBe(0)
  })

  it('switches headers as files take turns', async () => {
    const fs = new Growing(new Map())
    fs.set('/d/p', 'p\n')
    fs.set('/d/q', 'q\n')
    const abort = new AbortController()
    const [stream] = (await tailGeneric(
      [spec('/d/p'), spec('/d/q')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.append('/d/p', 'p2\n')
      await sleep(60)
      fs.append('/d/q', 'q2\n')
      await sleep(60)
      fs.append('/d/q', 'q3\n')
    })()
    const text = await drainFor(stream, 350, abort)
    await grower
    expect(text).toBe(
      '==> /d/p <==\np\n\n==> /d/q <==\nq\n\n==> /d/p <==\np2\n\n==> /d/q <==\nq2\nq3\n',
    )
  })

  it('with nothing to follow says so', async () => {
    const fs = new Growing(new Map())
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/nope')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [null, IOResult]
    expect(stream).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array).endsWith('tail: no files remaining\n')).toBe(true)
  })

  it('-F waits for a file to appear', async () => {
    const fs = new Growing(new Map())
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/later')],
      [],
      opts({ F: true, sleep_interval: '0.02' }, abort.signal),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.set('/d/later', 'born\n')
    })()
    const text = await drainFor(stream, 250, abort)
    await grower
    expect(text).toBe('born\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toContain(
      "tail: '/d/later' has appeared;  following new file\n",
    )
  })

  it('--follow=name reports a file that vanishes', async () => {
    const fs = new Growing(new Map())
    fs.set('/d/gone', 'x\n')
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/gone')],
      [],
      followOpts(abort, { follow: 'name' }),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.data.delete('/d/gone')
    })()
    const text = await drainFor(stream, 250, abort)
    await grower
    expect(text).toBe('x\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      "tail: '/d/gone' has become inaccessible: No such file or directory\ntail: no files remaining\n",
    )
    expect(io.exitCode).toBe(1)
  })

  it.each([
    [
      { follow: 'bogus' },
      "tail: invalid argument 'bogus' for '--follow'\nValid arguments are:\n  - 'descriptor'\n  - 'name'\nTry 'tail --help' for more information.\n",
    ],
    [{ follow: true, sleep_interval: 'bogus' }, "tail: invalid number of seconds: 'bogus'\n"],
  ])('refuses %o in GNU words', async (flags, stderr) => {
    const fs = new Growing(new Map())
    fs.set('/d/log', 'x\n')
    const [stream, io] = (await tailGeneric(
      [spec('/d/log')],
      [],
      opts(flags),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [null, IOResult]
    expect(stream).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(stderr)
  })
})
