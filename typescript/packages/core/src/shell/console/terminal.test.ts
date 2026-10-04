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
import { Recorder } from '../descriptors.ts'
import { Channel, JobConsole, Tee, Terminal } from './index.ts'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const dec = ([out, err]: [Uint8Array, Uint8Array]): [string, string] => [
  new TextDecoder().decode(out),
  new TextDecoder().decode(err),
]

describe('Terminal', () => {
  it('a line takes what reached the terminal in order', async () => {
    const tty = new Terminal()
    await tty.jobs.emit(Channel.STDOUT, enc('early\n'))
    await tty.emit(Channel.STDOUT, enc('line\n'))
    await tty.emit(Channel.STDERR, enc('warn\n'))
    await tty.jobs.emit(Channel.STDOUT, enc('late\n'))
    expect(dec(tty.take())).toEqual(['early\nline\nlate\n', 'warn\n'])
    expect(dec(tty.take())).toEqual(['', ''])
  })

  it('a job writes into the statement running', async () => {
    const tty = new Terminal()
    const statement = new Recorder()
    tty.jobs.recorder = statement
    await tty.jobs.emit(Channel.STDOUT, enc('bg\n'))
    tty.jobs.recorder = null
    await tty.jobs.emit(Channel.STDOUT, enc('after\n'))
    expect(statement.chunks).toEqual([[Channel.STDOUT, enc('bg\n')]])
    expect(dec(tty.take())).toEqual(['after\n', ''])
  })

  it('a reader gets what waited and then everything', async () => {
    const tty = new Terminal()
    await tty.jobs.emit(Channel.STDOUT, enc('waited\n'))
    const reader = new JobConsole()
    await tty.attach(reader)
    await tty.emit(Channel.STDOUT, enc('now\n'))
    expect(new TextDecoder().decode(await reader.snapshot(Channel.STDOUT))).toBe('waited\nnow\n')
    expect(dec(tty.take())).toEqual(['', ''])
  })

  it('an abandoned line keeps only its jobs output', async () => {
    const tty = new Terminal()
    await tty.emit(Channel.STDOUT, enc('line\n'))
    await tty.jobs.emit(Channel.STDOUT, enc('job\n'))
    tty.dropLine()
    expect(dec(tty.take())).toEqual(['job\n', ''])
  })

  it('bounded output goes back ahead of later output', async () => {
    const tty = new Terminal()
    await tty.emit(Channel.STDOUT, enc('long line\n'))
    const [out, err] = tty.drain()
    await tty.jobs.emit(Channel.STDOUT, enc('later\n'))
    tty.putBack(out.subarray(0, 4), err)
    expect(dec(tty.take())).toEqual(['longlater\n', ''])
  })
})

describe('Tee', () => {
  it('keeps the console and copies the bytes', async () => {
    const console_ = new JobConsole()
    const copy = new JobConsole()
    await new Tee(console_, copy).emit(Channel.STDOUT, enc('x'))
    expect(new TextDecoder().decode(await console_.snapshot(Channel.STDOUT))).toBe('x')
    expect(new TextDecoder().decode(await copy.snapshot(Channel.STDOUT))).toBe('x')
  })
})
