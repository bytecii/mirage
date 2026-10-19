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
import type { ByteSource } from '../../io/types.ts'
import { SedMachine, type SedFileContent } from './sed_exec.ts'
import { compileScript } from './sed_script.ts'

const ENC = new TextEncoder()

function flush(): Promise<void> {
  return Promise.resolve()
}

interface RunOptions {
  suppress?: boolean
  separate?: boolean
  files?: ReadonlyMap<string, SedFileContent>
}

async function run(
  script: string,
  inputs: (string | ByteSource)[],
  options: RunOptions = {},
): Promise<[string, string, number, SedMachine]> {
  const program = compileScript([{ kind: 'expr', text: script }], false)
  const files = options.files ?? new Map()
  const machine = new SedMachine(program, {
    suppress: options.suppress ?? false,
    separate: options.separate ?? false,
    lineLength: 70,
    files,
    readerFiles: files,
    utf8: false,
  })
  let out = ''
  const sources = inputs.map((source, i) => ({
    name: `/in${String(i)}`,
    source: typeof source === 'string' ? ENC.encode(source) : source,
  }))
  for await (const chunk of machine.process(sources, true, undefined, flush)) out += chunk
  return [out, machine.stderr(), machine.exitCode(), machine]
}

function failingAfter(...chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield ENC.encode(chunk)
    await Promise.resolve()
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  })()
}

function failing(code: string, message: string): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(Object.assign(new Error(message), { code })),
      }
    },
  }
}

describe('SedMachine', () => {
  it.each([
    [':a;N;$!ba;s/\\n/,/g', 'a\nb\nc\n', 'a,b,c\n'],
    ['$!N;P;D', 'a\nb\nc\n', 'a\nb\nc\n'],
    ['s/x*/-/g', 'abxd\n', '-a-b-d-\n'],
    ['s/b*/X/2', 'abbb\n', 'aX\n'],
    ['2,4cMID', '1\n2\n3\n4\n5\n', '1\nMID\n5\n'],
    ['s/\\w\\+/\\u&/g', 'hello world\n', 'Hello World\n'],
    ['s/.*/\\u\\L&/', 'hELLO\n', 'hello\n'],
    ['s/.*/\\L\\u&/', 'hello\n', 'Hello\n'],
    ['s/\\(x*\\)\\(a\\)/\\u\\1\\2/', 'ab\n', 'Ab\n'],
    ['s/\\(x*\\)\\(y*\\)\\(a\\)/\\u\\1\\2\\3/', 'ab\n', 'ab\n'],
    ['s/x/[\\x26\\x5c1]/', 'x\n', '[&\\1]\n'],
    ['s/a\\x2eb/X/g', 'a.b axb\n', 'X X\n'],
    ['y/el/ip/', 'hello\n', 'hippo\n'],
    ['n;a X', 'a\nb\nc\n', 'a\nb\nX\nc\n'],
    ['$G', 'a\nb', 'a\nb\n\n'],
    ['p;q', 'abc', 'abc\nabc\n'],
  ])('runs %j as GNU does', async (script, data, want) => {
    const [out, err, code] = await run(script, [data])
    expect([out, err, code]).toEqual([want, '', 0])
  })

  it('holds a missing newline until more follows', async () => {
    expect((await run('p', ['a']))[0]).toBe('a\na')
    expect((await run('p;=', ['a\nb'], { suppress: true }))[0]).toBe('a\n1\nb\n2\n')
    expect((await run('w /dev/stdout', ['a\nb']))[0]).toBe('a\na\nbb')
  })

  it('wraps a listing without splitting an escape', async () => {
    expect((await run('l 5', ['aaa\tb\n'], { suppress: true }))[0]).toBe('aaa\\\n\\tb$\n')
    expect((await run('l 1', ['abc\n'], { suppress: true }))[0]).toBe('\\\na\\\nb\\\nc$\n')
  })

  it('opens a line-number range late, once', async () => {
    const data = '1\n2\n3\n4\n5\n6\n'
    const quiet = { suppress: true }
    expect((await run('1{n;b};2,3p', [data], quiet))[0]).toBe('3\n')
    expect((await run('1{n;n;b};2,3p', [data], quiet))[0]).toBe('')
    expect((await run('2,/4/p', [data], quiet))[0]).toBe('2\n3\n4\n')
    expect((await run('2,~4p', [data], quiet))[0]).toBe('2\n3\n4\n')
    expect((await run('4,~4p', [data], quiet))[0]).toBe('4\n5\n6\n')
  })

  it('restarts lines, hold and ranges for separate inputs', async () => {
    expect((await run('x', ['a\n', 'b\n'], { separate: true }))[0]).toBe('\n\n')
    expect((await run('$p', ['a\nb\n', 'c\n'], { suppress: true, separate: true }))[0]).toBe(
      'b\nc\n',
    )
    expect((await run('N', ['a\nb\nc\n', 'd\n'], { separate: true }))[0]).toBe('a\nb\nc\nd\n')
  })

  it('passes over a directory when it looks ahead', async () => {
    const quiet = { suppress: true }
    const [out, err, code] = await run(
      '$p',
      ['one\ntwo\n', failing('EISDIR', 'dir'), 'L1\n'],
      quiet,
    )
    expect([out, err, code]).toEqual(['L1\n', '', 0])
    const [read, readErr, readCode] = await run(
      'p',
      ['one\n', failing('EISDIR', 'dir'), 'L1\n'],
      quiet,
    )
    expect([read, readErr, readCode]).toEqual([
      'one\n',
      'sed: read error on /in1: Is a directory\n',
      4,
    ])
  })

  it('reads a line whole across chunks', async () => {
    const pieces = ['ab', 'c\nd', '', 'e', 'f\n', ...Array<string>(2000).fill('x'), '\n']
    const source = (async function* () {
      for (const piece of pieces) {
        await Promise.resolve()
        yield ENC.encode(piece)
      }
    })()
    expect((await run('', [source]))[0]).toBe('abc\ndef\n' + 'x'.repeat(2000) + '\n')
  })

  it("hands a loop's w file on as it runs", async () => {
    const program = compileScript([{ kind: 'expr', text: ':a\nw /f\nba' }], false)
    const machine = new SedMachine(program, {
      suppress: true,
      separate: false,
      lineLength: 70,
      files: new Map(),
      readerFiles: new Map(),
      utf8: false,
    })
    const stop = (): Promise<void> => Promise.reject(new Error('flushed'))
    const drain = async (): Promise<void> => {
      for await (const chunk of machine.process(
        [{ name: '-', source: ENC.encode('x\n') }],
        true,
        undefined,
        stop,
      ))
        void chunk
    }
    await expect(drain()).rejects.toThrow('flushed')
  })

  it('looks one byte ahead', async () => {
    const [out, err, code] = await run('$!p;q', [failingAfter('one\nx')], { suppress: true })
    expect([out, err, code]).toEqual(['one\n', '', 0])
  })

  it('ends an input that fails as it is looked into', async () => {
    const quiet = { suppress: true }
    expect((await run('$p', [failingAfter('first\n')], quiet)).slice(0, 3)).toEqual([
      'first\n',
      '',
      0,
    ])
    expect((await run('p', [failingAfter('first\n'), 'good\n'], quiet)).slice(0, 3)).toEqual([
      'first\n',
      'sed: read error on /in0: Permission denied\n',
      4,
    ])
  })

  it('reports a missing input and reads on past it', async () => {
    const [out, err, code] = await run('q5', [failing('ENOENT', 'gone'), 'one\n'])
    expect([out, err, code]).toEqual([
      'one\n',
      "sed: can't read /in0: No such file or directory\n",
      2,
    ])
  })

  it('queues appended text and files', async () => {
    const files = new Map([['/r', { text: 'R1\n' }]])
    expect((await run('1r /r\n1a X\n2r/r', ['a\nb\nc\n'], { files }))[0]).toBe(
      'a\nR1\nX\nb\nR1\nc\n',
    )
    expect((await run('0r /r', ['a\n'], { files }))[0]).toBe('R1\na\n')
    expect((await run('1r /r\n1Q', ['a\n'], { files }))[0]).toBe('')
  })

  it('streams an r file and reports a failed read', async () => {
    const files = new Map([['/r', { read: () => failingAfter('R1\n', 'R2') }]])
    const [out, err, code] = await run('1r /r\n$a X', ['a\nb\n'], { files })
    expect([out, err, code]).toEqual(['a\nR1\nR2', 'sed: read error on /r: Permission denied\n', 4])
  })

  it('lets an abort end a stalled r or R read', async () => {
    for (const script of ['1r /r', 'R /r']) {
      let closed = false
      const stalled = (): AsyncIterable<Uint8Array> => ({
        [Symbol.asyncIterator]: () => {
          let sent = false
          return {
            next: () => {
              if (sent) return new Promise<IteratorResult<Uint8Array>>(() => undefined)
              sent = true
              return Promise.resolve({ done: false, value: ENC.encode('R') })
            },
            return: () => {
              closed = true
              return Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      })
      const files = new Map([['/r', { read: stalled }]])
      const program = compileScript([{ kind: 'expr', text: script }], false)
      const machine = new SedMachine(program, {
        suppress: false,
        separate: false,
        lineLength: 70,
        files,
        readerFiles: files,
        utf8: false,
      })
      const controller = new AbortController()
      const drain = async (): Promise<void> => {
        const inputs = [{ name: '-', source: ENC.encode('x\n') }]
        for await (const chunk of machine.process(inputs, true, controller.signal, flush))
          void chunk
      }
      const done = drain()
      setTimeout(() => {
        controller.abort()
      }, 10)
      await expect(done).rejects.toThrow('execute aborted')
      expect(closed).toBe(true)
    }
  })

  it('cuts an R file at newlines only', async () => {
    const files = new Map([['/r', { text: 'left\rright\nnext\n' }]])
    expect((await run('R /r', ['1\n2\n'], { files }))[0]).toBe('1\nleft\rright\n2\nnext\n')
  })

  it('keeps the append queue when D restarts', async () => {
    expect((await run('$!N;a X\nP;D', ['a\nb\n']))[0]).toBe('a\nb\nX\nX\n')
  })

  it('runs 0r where the script reaches it', async () => {
    const files = new Map([['/r', { text: 'R\n' }]])
    expect((await run('p;0r /r', ['x\n'], { files }))[0]).toBe('x\nR\nx\n')
    expect((await run('b;0r /r', ['x\n'], { files }))[0]).toBe('x\n')
    expect((await run('1d;0r /r', ['x\ny\n'], { files }))[0]).toBe('y\n')
  })

  it('keeps quit codes and the empty regex as GNU does', async () => {
    const [, , code, machine] = await run('2q300', ['a\nb\nc\n'])
    expect([code, machine.stopped()]).toEqual([44, true])
    const [, err, failed] = await run('2{/a/p};1{//p}', ['a\nb\n'], { suppress: true })
    expect([err, failed]).toEqual([
      'sed: -e expression #1, char 0: no previous regular expression\n',
      1,
    ])
    expect((await run('/a/I{s//x/p}', ['AB\n'], { suppress: true }))[0]).toBe('xB\n')
  })
})
