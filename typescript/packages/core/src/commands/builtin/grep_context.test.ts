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
import { grepContextLines, grepContextStream } from './grep_context.ts'
import { decodeLine } from './grep_offsets.ts'

// one\ntwo abc\nthree\nfour\nfive abc\nsix\n, the fixture every row below was
// measured against on GNU grep 3.11 under LC_ALL=C.
const LINES = ['one', 'two abc', 'three', 'four', 'five abc', 'six']
const ENC = new TextEncoder()

interface Opts {
  pat?: RegExp
  invert?: boolean
  lineNumbers?: boolean
  maxCount?: number | null
  afterContext?: number
  beforeContext?: number
  byteOffsets?: boolean
  label?: string
  trailingMatches?: boolean
}

function render(lines: readonly string[], o: Opts = {}): number[][] {
  return grepContextLines(
    lines,
    o.pat ?? /abc/,
    o.invert ?? false,
    o.lineNumbers ?? false,
    o.maxCount ?? null,
    o.afterContext ?? 0,
    o.beforeContext ?? 0,
    o.byteOffsets ?? false,
    o.label ?? null,
    o.trailingMatches ?? false,
  ).map((chunk) => [...chunk])
}

// Expected chunks are written as text where they are valid UTF-8, and as
// explicit bytes where they are not.
function bytes(...texts: string[]): number[][] {
  return texts.map((t) => [...ENC.encode(t)])
}

describe('-m 0 selects nothing', () => {
  // Measured: `grep -m0 -A1 abc f` and `grep -m0 -B1 -c abc f` are both zero
  // bytes and exit 1 on GNU grep 3.11. Reading the limit after the match was
  // recorded kept the first one, because `length >= 0` is already true -- this
  // host's `!== null` kept exactly one line and the python twin's falsy test
  // skipped the check entirely and rendered every match, so the two were
  // wrong in different directions.
  it('renders no context lines at all', () => {
    expect(render(LINES, { maxCount: 0, afterContext: 1, beforeContext: 1 })).toEqual([])
  })

  it('does not render even the selected line', () => {
    expect(render(LINES, { maxCount: 0 })).toEqual([])
  })

  it('renders nothing for an inverted selection either', () => {
    expect(render(LINES, { maxCount: 0, invert: true, afterContext: 1 })).toEqual([])
  })
})

describe('-m N stops at the Nth selected line', () => {
  it('renders one match with context on both sides', () => {
    // `grep -m1 -n -A1 -B1 abc f`
    expect(
      render(LINES, { maxCount: 1, lineNumbers: true, afterContext: 1, beforeContext: 1 }),
    ).toEqual(bytes('1-one\n', '2:two abc\n', '3-three\n'))
  })

  it('renders both groups with no limit', () => {
    // `grep -n -A1 -B1 abc f` -- the two windows touch, so GNU emits no `--`.
    expect(render(LINES, { lineNumbers: true, afterContext: 1, beforeContext: 1 })).toEqual(
      bytes('1-one\n', '2:two abc\n', '3-three\n', '4-four\n', '5:five abc\n', '6-six\n'),
    )
  })
})

describe('separator and fields', () => {
  it('puts a bare -- between groups that do not touch', () => {
    // `grep -b -A1 abc f`: the separator carries no fields of its own.
    expect(render(LINES, { afterContext: 1, byteOffsets: true })).toEqual(
      bytes('4:two abc\n', '12-three\n', '--\n', '23:five abc\n', '32-six\n'),
    )
  })

  it('renders every field of a context line with a dash', () => {
    // `grep -bn -A1 -B1 abc f`
    expect(
      render(LINES, {
        lineNumbers: true,
        afterContext: 1,
        beforeContext: 1,
        byteOffsets: true,
      }),
    ).toEqual(
      bytes(
        '1-0-one\n',
        '2:4:two abc\n',
        '3-12-three\n',
        '4-18-four\n',
        '5:23:five abc\n',
        '6-32-six\n',
      ),
    )
  })

  it('moves which lines are selected under invert', () => {
    // `grep -nv -A1 abc f`
    expect(render(LINES, { invert: true, lineNumbers: true, afterContext: 1 })).toEqual(
      bytes('1:one\n', '2-two abc\n', '3:three\n', '4:four\n', '5-five abc\n', '6:six\n'),
    )
  })
})

describe('offsets over a smuggled byte', () => {
  // Fixture `one\n\377\ntwo abc\nthree\n`, measured on GNU grep 3.11:
  // `grep -b -A1 abc` is `6:two abc` then `14-three`, `grep -b -B1 abc` is
  // `4-\377` then `6:two abc`, and `grep -bn -A1 -B1 abc` is `2-4-\377`,
  // `3:6:two abc`, `4-14-three`. A replacing decode read `\377` as U+FFFD,
  // three bytes wide, so every offset past it ran ahead -- line three
  // reported 8 rather than 6.
  const binLines = (): string[] => ['one', decodeLine(new Uint8Array([0xff])), 'two abc', 'three']

  it('counts one byte for the after-context offsets', () => {
    expect(render(binLines(), { afterContext: 1, byteOffsets: true })).toEqual(
      bytes('6:two abc\n', '14-three\n'),
    )
  })

  it('prints the raw byte back on a before-context line', () => {
    // The renderer puts the line back with `encodeLine`, so the byte prints
    // as GNU prints it rather than as U+FFFD. This is what `grep -a -b -B1`
    // renders end to end.
    expect(render(binLines(), { beforeContext: 1, byteOffsets: true })).toEqual([
      [0x34, 0x2d, 0xff, 0x0a],
      ...bytes('6:two abc\n'),
    ])
  })

  it('gets every field right on both sides', () => {
    expect(
      render(binLines(), {
        lineNumbers: true,
        afterContext: 1,
        beforeContext: 1,
        byteOffsets: true,
      }),
    ).toEqual([[0x32, 0x2d, 0x34, 0x2d, 0xff, 0x0a], ...bytes('3:6:two abc\n', '4-14-three\n')])
  })

  it('counts the bytes of a multi-byte character', () => {
    // `caf` + U+00E9 is five bytes, so the second line starts at 10 once the
    // space and terminator are counted (section Q6's fixture).
    expect(render(['café abc', 'xéy abc'], { afterContext: 1, byteOffsets: true })).toEqual(
      bytes('0:café abc\n', '10:xéy abc\n'),
    )
  })
})

it('renders nothing when nothing matched', () => {
  expect(render(LINES, { pat: /zzz/, afterContext: 1 })).toEqual([])
})

// eslint-disable-next-line @typescript-eslint/require-await
async function* chunks(data: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let start = 0; start < data.length; start += size) yield data.subarray(start, start + size)
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* thenFail(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data
  throw new Error('read past the answer')
}

async function stream(source: AsyncIterable<Uint8Array>, o: Opts = {}): Promise<number[][]> {
  const out: number[][] = []
  for await (const chunk of grepContextStream(
    source,
    o.pat ?? /abc/,
    o.invert ?? false,
    o.lineNumbers ?? false,
    o.maxCount ?? null,
    o.afterContext ?? 0,
    o.beforeContext ?? 0,
    o.byteOffsets ?? false,
    o.label ?? null,
    o.trailingMatches ?? false,
  )) {
    out.push([...chunk])
  }
  return out
}

describe('grepContextStream', () => {
  it.each([
    [{ afterContext: 1, beforeContext: 1, lineNumbers: true }],
    [{ beforeContext: 1, byteOffsets: true }],
    [{ afterContext: 2, maxCount: 1 }],
    [{ afterContext: 1, invert: true }],
    [{ afterContext: 1, lineNumbers: true, label: 'f' }],
    [{ afterContext: 3, maxCount: 1, trailingMatches: true }],
  ])('renders what the lines render: %j', async (o: Opts) => {
    const data = ENC.encode(LINES.join('\n') + '\n')
    expect((await stream(chunks(data, 3), o)).flat()).toEqual(render(LINES, o).flat())
  })

  it('stops once max count and its context are out', async () => {
    // The answer to -m1 -A1 is settled by the line after the match, so a pipe
    // that goes on after it is never read.
    const source = thenFail(ENC.encode('one\ntwo abc\nthree\n'))
    expect(await stream(source, { maxCount: 1, afterContext: 1 })).toEqual(
      bytes('two abc\n', 'three\n'),
    )
  })
})

// A labelled line leads with its file's name: `name:` on a selected line and
// `name-` on a context line, the `--` between groups carrying no name (`rg -n
// -A1 abc f` and `grep -H -n -A1 abc f` agree on this).
describe('labelled lines', () => {
  it('lead with the name on selected and context lines alike', () => {
    expect(
      render(LINES, { lineNumbers: true, afterContext: 1, beforeContext: 1, label: 'f' }),
    ).toEqual(
      bytes(
        'f-1-one\n',
        'f:2:two abc\n',
        'f-3-three\n',
        'f-4-four\n',
        'f:5:five abc\n',
        'f-6-six\n',
      ),
    )
  })

  it('leave the separator without a name', () => {
    expect(render(LINES, { lineNumbers: true, afterContext: 1, label: 'f' })).toEqual(
      bytes('f:2:two abc\n', 'f-3-three\n', '--\n', 'f:5:five abc\n', 'f-6-six\n'),
    )
  })
})

// A line past -m that would be selected, inside the trailing context. ripgrep
// 14.1.1 prints it as selected and still counts it as context: `rg -n -m1 -A3
// o` over hello/world/foo/bar prints `1:hello`, `2:world`, `3:foo`, `4-bar`.
// GNU grep 3.11 prints it as context: `grep -n -m1 -A2 o` prints `1:hello`,
// `2-world`, `3-foo`.
describe('trailing matches', () => {
  const WORDS = ['hello', 'world', 'foo', 'bar', 'baz']
  const o = { pat: /o/, lineNumbers: true, maxCount: 1 }

  it('print as selected the way ripgrep prints them', () => {
    expect(render(WORDS, { ...o, afterContext: 3, trailingMatches: true })).toEqual(
      bytes('1:hello\n', '2:world\n', '3:foo\n', '4-bar\n'),
    )
  })

  it('print as context the way GNU prints them', () => {
    expect(render(WORDS, { ...o, afterContext: 2 })).toEqual(
      bytes('1:hello\n', '2-world\n', '3-foo\n'),
    )
  })

  it('still count as context', () => {
    // `rg -n -m1 -A1 o` stops after one trailing line, selected or not.
    expect(render(WORDS, { ...o, afterContext: 1, trailingMatches: true })).toEqual(
      bytes('1:hello\n', '2:world\n'),
    )
  })
})
