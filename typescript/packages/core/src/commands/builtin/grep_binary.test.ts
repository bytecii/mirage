import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { specOf } from '../spec/builtins.ts'
import { FlagView } from '../spec/flag_view.ts'
import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { parseFlags } from './generic/grep.ts'
import { grepInput, PROBE_BLOCK_BYTES } from './grep_binary.ts'
import { compilePerl } from './grep_pattern.ts'
import { parseCommand, parseToKwargs } from '../spec/parser.ts'
import { UsageError } from '../errors.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe.each([1, 2, 7, 1024, PROBE_BLOCK_BYTES])(
  'binary grep with %i-byte backend chunks',
  (size) => {
    it.each([
      ['binary', '', 'grep: /remote/data.pdf: binary file matches\n', 0],
      ['without-match', '', '', 1],
      ['text', '2:needle\0tail\n', '', 0],
    ] as const)(
      '%s mode is independent of transport chunking',
      async (mode, stdout, stderr, code) => {
        const data = ENC.encode('before\nneedle\0tail\n')
        async function* source(): AsyncIterable<Uint8Array> {
          await Promise.resolve()
          for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
        }
        const f = parseFlags(
          new FlagView({ binary_files: mode, line_number: true }, specOf('grep')),
        )
        const io = new IOResult({ exitCode: 1 })
        const out = await materialize(
          grepInput(source(), /needle/, f, '/remote/data.pdf', false, io),
        )
        expect(DEC.decode(out)).toBe(stdout)
        expect(DEC.decode((io.stderr as Uint8Array | null) ?? undefined)).toBe(stderr)
        expect(io.exitCode).toBe(code)
      },
    )
    it('preserves multibyte text split across reads', async () => {
      const data = ENC.encode('é needle 😀\n')
      async function* source(): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
      }
      const f = parseFlags(new FlagView({}, specOf('grep')))
      const io = new IOResult({ exitCode: 1 })
      expect(
        await materialize(grepInput(source(), /needle/, f, '/doc.gdoc.json', false, io)),
      ).toEqual(data)
      expect(io.exitCode).toBe(0)
      expect(io.stderr).toBeNull()
    })
  },
)

it.each([{ args_I: true }, { quiet: true }, {}])('bounds remote reads for %j', async (flags) => {
  const block = new Uint8Array(PROBE_BLOCK_BYTES).fill(120)
  block.set(ENC.encode('needle\0'))
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      yield block
      throw new Error('unnecessary remote read')
    } finally {
      closed = true
    }
  }
  const f = parseFlags(new FlagView(flags, specOf('grep')))
  const io = new IOResult({ exitCode: 1 })
  expect(
    await materialize(grepInput(source(), /needle/, f, '/remote/large.pdf', false, io)),
  ).toEqual(new Uint8Array())
  expect(closed).toBe(true)
})

it('does not read past the probe block for max-count', async () => {
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      yield ENC.encode('needle\n' + 'x'.repeat(PROBE_BLOCK_BYTES - 7))
      throw new Error('read past the requested match')
    } finally {
      closed = true
    }
  }
  const f = parseFlags(new FlagView({ max_count: 1 }, specOf('grep')))
  const io = new IOResult()
  expect(
    await materialize(grepInput(source(), /needle/, f, '/remote/rows.jsonl', false, io)),
  ).toEqual(ENC.encode('needle\n'))
  expect(io.exitCode).toBe(0)
  expect(closed).toBe(true)
})

it.each([
  [{ before_context: '-1' }, '-1'],
  [{ after_context: '-1' }, '-1'],
  [{ context: '-1' }, '-1'],
  [{ after_context: 'x' }, 'x'],
  [{ before_context: '1.5' }, '1.5'],
  [{ before_context: -1 }, '-1'],
  [{ before_context: '-1', after_context: 'x' }, '-1'],
  [{ after_context: 'x', before_context: '-1' }, 'x'],
])('rejects an invalid context length %j', (flags, shown) => {
  expect(() => parseFlags(new FlagView(flags, specOf('grep')))).toThrow(
    new UsageError(`grep: ${shown}: invalid context length argument`),
  )
})

it.each([{ before_context: '-0' }, { after_context: '0' }, { context: 2 }])(
  'accepts context length %j',
  (flags) => {
    expect(() => parseFlags(new FlagView(flags, specOf('grep')))).not.toThrow()
  },
)

it.each(['', 'bogus'])('rejects invalid binary mode %j', (value) => {
  expect(() => parseFlags(new FlagView({ binary_files: value }, specOf('grep')))).toThrow(
    'unknown binary-files type',
  )
})

describe.each([1024, PROBE_BLOCK_BYTES, 2 * PROBE_BLOCK_BYTES])(
  'late NUL with %i-byte backend chunks',
  (size) => {
    describe.each(['', '\n'])('preceding block ends with %j', (lineEnd) => {
      describe.each([false, true])('count-only %j', (countOnly) => {
        it.each([{ args_I: true }, { binary_files: 'without-match' }])(
          'discards earlier matches with %j',
          async (binaryFlag) => {
            const data = ENC.encode(
              'needle\n' +
                'x'.repeat(PROBE_BLOCK_BYTES - 7 - lineEnd.length) +
                lineEnd +
                '\0tail\n',
            )
            let closed = false
            async function* source(): AsyncIterable<Uint8Array> {
              await Promise.resolve()
              try {
                for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
                throw new Error('read past the binary block')
              } finally {
                closed = true
              }
            }
            const f = parseFlags(new FlagView({ ...binaryFlag, count: countOnly }, specOf('grep')))
            const io = new IOResult()
            const out = await materialize(
              grepInput(source(), /needle/, f, '/remote/late.txt', true, io),
            )
            // Streaming output already emitted before the NUL cannot be retracted.
            expect(DEC.decode(out)).toBe(
              countOnly ? '/remote/late.txt:0\n' : '/remote/late.txt:needle\n',
            )
            expect(io.stderr).toBeNull()
            expect(io.exitCode).toBe(1)
            expect(closed).toBe(true)
          },
        )
      })
    })
  },
)

it.each([
  [{ max_count: 1, count: true }, '1\n'],
  [{ quiet: true }, ''],
  [{ files_with_matches: true }, '/remote/rows.jsonl\n'],
] as const)('does not read ahead after without-match early stop %j', async (flags, expected) => {
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      yield ENC.encode('needle\n' + 'x'.repeat(PROBE_BLOCK_BYTES - 7))
      throw new Error('read past the requested match')
    } finally {
      closed = true
    }
  }
  const f = parseFlags(new FlagView({ args_I: true, ...flags }, specOf('grep')))
  const io = new IOResult()
  const out = await materialize(grepInput(source(), /needle/, f, '/remote/rows.jsonl', false, io))
  expect(DEC.decode(out)).toBe(expected)
  expect(io.stderr).toBeNull()
  expect(io.exitCode).toBe(0)
  expect(closed).toBe(true)
})

async function* lines(text: string): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(text)
}

it.each([
  [{ after_context: 1 }, true, '--\nf:a\nf-b\n'],
  [{ after_context: 1 }, false, 'f:a\nf-b\n'],
  [{ before_context: 1 }, true, '--\nf:a\n'],
  [{ count: true, after_context: 1 }, true, 'f:1\n'],
  [{ only_matching: true, after_context: 1 }, true, '--\nf:a\n'],
  [{ after_context: 0 }, true, '--\nf:a\n'],
  [{ after_context: 0, no_group_separator: true }, true, 'f:a\n'],
  [{ context: 0, group_separator: '::' }, true, '::\nf:a\n'],
  [{}, true, 'f:a\n'],
])(
  'opens a context group after earlier output with the separator %j %s',
  async (flags, afterOutput, expected) => {
    const f = parseFlags(new FlagView(flags, specOf('grep')))
    const io = new IOResult()
    const out = await materialize(grepInput(lines('a\nb\n'), /a/, f, 'f', true, io, afterOutput))
    expect(new TextDecoder().decode(out)).toBe(expected)
  },
)

it.each([
  ['binary', 'needle\n', '', 0],
  ['without-match', 'needle\n', '', 1],
  ['text', 'needle\n', '', 0],
] as const)(
  // (printf 'needle\n'; sleep 1; printf '\0tail\n') | grep needle prints the
  // match under GNU 3.11 too; only a later match is suppressed, and -I still
  // reports 1. Merging chunks to avoid this would read ahead.
  'a NUL in a later chunk is GNU pipe behavior in %s mode',
  async (mode, stdout, stderr, code) => {
    let closed = false
    async function* source(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      try {
        yield ENC.encode('needle\n')
        yield ENC.encode('\0tail\n')
      } finally {
        closed = true
      }
    }
    const f = parseFlags(new FlagView({ binary_files: mode }, specOf('grep')))
    const io = new IOResult({ exitCode: 1 })
    const out = await materialize(grepInput(source(), /needle/, f, '/remote/data.pdf', false, io))
    expect(DEC.decode(out)).toBe(stdout)
    expect(DEC.decode((io.stderr as Uint8Array | null) ?? undefined)).toBe(stderr)
    expect(io.exitCode).toBe(code)
    expect(closed).toBe(true)
  },
)

it.each([
  ['a\0b\n', /^/, 'grep: /data/z: binary file matches\n'],
  ['a\0b\nzz\n', /z*/, 'grep: /data/z: binary file matches\n'],
  ['a\xffb\n', /^/, ''],
] as const)('a zero-width -o match on %j still notices a NUL', async (text, pattern, stderr) => {
  const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0))
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield bytes
  }
  const f = parseFlags(new FlagView({ only_matching: true }, specOf('grep')))
  const io = new IOResult({ exitCode: 1 })
  const out = await materialize(grepInput(source(), pattern, f, '/data/z', false, io))
  expect(DEC.decode(out)).toBe('')
  expect(DEC.decode((io.stderr as Uint8Array | null) ?? undefined)).toBe(stderr)
  expect(io.exitCode).toBe(0)
})

// -m0 selects no line and the whole command goes quiet, -c included.
// Measured on GNU grep 3.11: `grep -m0 a f`, `grep -m0 -c a f`,
// `grep -m0 -v a f`, `grep -m0 -l a f`, `grep -m0 -o a f`, `grep -m0 -A1 a f`
// and `grep -m0 -c a f g` are all zero bytes and exit 1, across the `-m0`,
// `-m 0` and `--max-count=0` spellings. -c printing a bare `0` here would be
// wrong twice over: GNU prints nothing, and a GENUINE zero still prints `0`
// (`grep -c a g` is `0\n`, exit 1), so the two cases have to stay
// distinguishable.
it.each([
  [{ max_count: 0 }],
  [{ max_count: 0, count: true }],
  [{ max_count: 0, invert_match: true }],
  [{ max_count: 0, files_with_matches: true }],
  [{ max_count: 0, only_matching: true }],
  [{ max_count: 0, after_context: '1' }],
  [{ max_count: 0, count: true, line_number: true, b: true }],
])('prints nothing and closes the unread source under -m0 with %j', async (flags) => {
  // A source whose mounts are already held before the first read.
  let closed = false
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => Promise.reject(new Error('read under -m0')),
    return: () => {
      closed = true
      return Promise.resolve({ done: true as const, value: undefined })
    },
  }
  const f = parseFlags(new FlagView(flags, specOf('grep')))
  const io = new IOResult()
  const out = await materialize(grepInput(source, /needle/, f, '/remote/rows.jsonl', false, io))
  expect(DEC.decode(out)).toBe('')
  expect(io.exitCode).toBe(1)
  expect(closed).toBe(true)
})

it('still prints a genuine zero count', async () => {
  // The mirror of the -m0 rows above: without -m0, `grep -c` on a file
  // holding no match prints `0` and exits 1 (GNU grep 3.11).
  const f = parseFlags(new FlagView({ count: true }, specOf('grep')))
  const io = new IOResult({ exitCode: 1 })
  const out = await materialize(grepInput(lines('a\nb\n'), /needle/, f, '/data/z', false, io))
  expect(DEC.decode(out)).toBe('0\n')
  expect(io.exitCode).toBe(1)
})

// The byte layout of every fixture below is section Q1 of the GNU truth
// file, measured against GNU grep 3.11.
const F1 = 'abc\ndefabc\nabc abc\n'
const F3 = 'one\ntwo abc\nthree\nfour abc\nfive\n'
const F4 = 'a\nb\nHIT\nc\nd\ne\nf\nHIT\ng\n'
const F5 = 'café abc\nxéy abc\n'
const F6 = 'no-newline-abc'

async function runB(
  text: string,
  flags: Record<string, unknown>,
  pattern: RegExp,
  show: boolean,
): Promise<[string, number]> {
  const data = ENC.encode(text)
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield data
  }
  const f = parseFlags(new FlagView(flags as never, specOf('grep')))
  const io = new IOResult({ exitCode: 1 })
  const out = await materialize(grepInput(source(), pattern, f, 'f', show, io))
  return [DEC.decode(out), io.exitCode]
}

describe('grep -b / --byte-offset', () => {
  it.each([
    // Without -o the number is the offset of the LINE's first byte: line
    // two prints 4, not the 7 its match sits at.
    [F1, { byte_offset: true }, false, '0:abc\n4:defabc\n11:abc abc\n', 0],
    // With -o it is the offset of the match, and a line with two matches
    // prints both.
    [F1, { byte_offset: true, only_matching: true }, false, '0:abc\n7:abc\n11:abc\n15:abc\n', 0],
    // Field order is FILENAME, LINE NUMBER, BYTE OFFSET, fixed by the
    // renderer rather than by the order the flags were given in.
    [F1, { byte_offset: true, line_number: true }, false, '1:0:abc\n2:4:defabc\n3:11:abc abc\n', 0],
    [
      F1,
      { byte_offset: true, with_filename: true },
      true,
      'f:0:abc\nf:4:defabc\nf:11:abc abc\n',
      0,
    ],
    [
      F1,
      { byte_offset: true, line_number: true, with_filename: true, only_matching: true },
      true,
      'f:1:0:abc\nf:2:7:abc\nf:3:11:abc\nf:3:15:abc\n',
      0,
    ],
    // -b does not reach a count, a file list or -q.
    [F1, { byte_offset: true, count: true }, false, '3\n', 0],
    [F3, { byte_offset: true, count: true }, false, '2\n', 0],
    [F1, { byte_offset: true, count: true, with_filename: true }, true, 'f:3\n', 0],
    [F1, { byte_offset: true, files_with_matches: true }, false, 'f\n', 0],
    [F1, { byte_offset: true, quiet: true }, false, '', 0],
    // -v prints the line-start offsets of the lines it did not select.
    [F3, { byte_offset: true, invert_match: true }, false, '0:one\n12:three\n27:five\n', 0],
    [F1, { byte_offset: true, invert_match: true }, false, '', 1],
    [F3, { byte_offset: true, max_count: '1' }, false, '4:two abc\n', 0],
    // A missing final newline does not shift an offset, and must not be
    // counted twice.
    [F6, { byte_offset: true }, false, '0:no-newline-abc\n', 0],
    [F6, { byte_offset: true, only_matching: true }, false, '11:abc\n', 0],
  ] as const)(
    'prints the line start or the match for %j',
    async (text, flags, show, want, code) => {
      expect(await runB(text, flags, /abc/, show)).toEqual([want, code])
    },
  )

  it.each([
    [
      F3,
      /abc/,
      { byte_offset: true, after_context: '1' },
      false,
      '4:two abc\n12-three\n18:four abc\n27-five\n',
    ],
    [
      F3,
      /abc/,
      { byte_offset: true, before_context: '1' },
      false,
      '0-one\n4:two abc\n12-three\n18:four abc\n',
    ],
    [
      F3,
      /abc/,
      { byte_offset: true, context: '1' },
      false,
      '0-one\n4:two abc\n12-three\n18:four abc\n27-five\n',
    ],
    [F3, /three/, { byte_offset: true, after_context: '1' }, false, '12:three\n18-four abc\n'],
    // Every field on a context line takes `-`, the separator being chosen
    // once per line rather than per field.
    [
      F3,
      /abc/,
      { byte_offset: true, line_number: true, context: '1' },
      false,
      '1-0-one\n2:4:two abc\n3-12-three\n4:18:four abc\n5-27-five\n',
    ],
    [
      F3,
      /abc/,
      { byte_offset: true, line_number: true, with_filename: true, context: '1' },
      true,
      'f-1-0-one\nf:2:4:two abc\nf-3-12-three\nf:4:18:four abc\nf-5-27-five\n',
    ],
    // The group separator is a bare `--` with no prefix fields at all.
    [
      F4,
      /HIT/,
      { byte_offset: true, line_number: true, context: '1' },
      false,
      '2-2-b\n3:4:HIT\n4-8-c\n--\n7-14-f\n8:16:HIT\n9-20-g\n',
    ],
    // -o beats -C entirely: only matches, no context and no separator.
    [F3, /abc/, { byte_offset: true, only_matching: true, context: '1' }, false, '8:abc\n23:abc\n'],
  ] as const)(
    'gives a context line the dash separator for %j',
    async (text, pattern, flags, show, want) => {
      expect(await runB(text, flags, pattern, show)).toEqual([want, 0])
    },
  )

  it.each([
    // An empty match prints nothing under -ob, exactly as under -o, and
    // the line is still selected.
    ['ab\n', /[0-9]*/, { byte_offset: true, only_matching: true }, ''],
    ['ab\n', new RegExp(''), { byte_offset: true, only_matching: true }, ''],
    ['a1b\n', /[0-9]*/, { byte_offset: true, only_matching: true }, '1:1\n'],
    ['a1b\nc2d\n', /[0-9]*/, { byte_offset: true, only_matching: true }, '1:1\n5:2\n'],
    ['ab\ncd\n', /[0-9]*/, { byte_offset: true }, '0:ab\n3:cd\n'],
  ] as const)(
    'treats an empty match under -ob as under -o for %j',
    async (text, pattern, flags, want) => {
      expect(await runB(text, flags, pattern, false)).toEqual([want, 0])
    },
  )

  it.each([
    // `caf` + U+00E9 (two bytes) + a space is six bytes, so the match sits
    // at byte 6 and not at the code-unit index 5; line two starts at 10 and
    // its match is at 15, not 13. GNU reports the same numbers under C and
    // C.utf8.
    [{ byte_offset: true, only_matching: true }, '6:abc\n15:abc\n'],
    [{ byte_offset: true, only_matching: true, line_number: true }, '1:6:abc\n2:15:abc\n'],
    [{ byte_offset: true }, '0:café abc\n10:xéy abc\n'],
  ] as const)('counts bytes rather than characters for %j', async (flags, want) => {
    expect(await runB(F5, flags, /abc/, false)).toEqual([want, 0])
  })
})

it.each([
  [['-b', 'abc', 'f'], true],
  [['--byte-offset', 'abc', 'f'], true],
  [['-bn', 'abc', 'f'], true],
  [['abc', 'f'], false],
])('reaches the generic as byteOffsets for %j', (argv, want) => {
  // The dest of -b/--byte-offset is `byte_offset`, so a query for the short
  // spelling would read as absent without the parser ever complaining.
  const bag = parseToKwargs(parseCommand(specOf('grep'), argv, '/'))
  expect(parseFlags(new FlagView(bag, specOf('grep'))).byteOffsets).toBe(want)
})

// grep -L / --files-without-match, measured on GNU grep 3.11: the listing is
// inverted but the exit status is not, -l and -L are one mode the later one
// wins, -L outranks -c, and -m0 lists the file since nothing was selected.
// Mirrored in test_grep.py.
describe('grep -L / --files-without-match', () => {
  it('lists a matchless input and keeps the match status', async () => {
    expect(await runB('hello\nworld\n', { files_without_match: true }, /hello/, false)).toEqual([
      '',
      0,
    ])
    expect(await runB('foo\n', { files_without_match: true }, /hello/, false)).toEqual(['f\n', 1])
  })

  it('outranks -c and lists the file under -m0', async () => {
    expect(await runB('foo\n', { files_without_match: true, count: true }, /hello/, false)).toEqual(
      ['f\n', 1],
    )
    expect(
      await runB('hello\n', { files_without_match: true, max_count: '0' }, /hello/, false),
    ).toEqual(['f\n', 1])
  })

  it('is one mode with -l, the later one winning', async () => {
    expect(
      await runB(
        'hello\n',
        { files_with_matches: true, files_without_match: true },
        /hello/,
        false,
      ),
    ).toEqual(['', 0])
    expect(
      await runB(
        'hello\n',
        { files_without_match: true, files_with_matches: true },
        /hello/,
        false,
      ),
    ).toEqual(['f\n', 0])
  })
})

it.each([false, true])(
  'only-matching offsets count bytes along one long line, -b=%s',
  async (byteOffsets) => {
    const count = 8000
    const row = 'é😀' + 'x'.repeat(100) + 'needle'
    const data = ENC.encode(row.repeat(count))
    async function* source(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield data
    }
    const f = parseFlags(
      new FlagView({ only_matching: true, byte_offset: byteOffsets }, specOf('grep')),
    )
    const io = new IOResult()
    const out = await materialize(grepInput(source(), /needle/, f, 'large.json', false, io))
    const stride = ENC.encode(row).length
    const expected = Array.from(
      { length: count },
      (_, i) => (byteOffsets ? String((i + 1) * stride - 6) + ':' : '') + 'needle\n',
    ).join('')
    expect(DEC.decode(out)).toBe(expected)
    expect(io.exitCode).toBe(0)
  },
)

it('allows timer cancellation while collecting matches from one line', async () => {
  const controller = new AbortController()
  const data = ENC.encode('needle '.repeat(100000) + '\n')
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      timer = setTimeout(() => {
        controller.abort()
      }, 0)
      yield data
      throw new Error('read beyond the matching line')
    } finally {
      closed = true
    }
  }
  try {
    const f = parseFlags(new FlagView({ only_matching: true, byte_offset: true }, specOf('grep')))
    await expect(
      materialize(
        grepInput(
          source(),
          /needle/,
          f,
          'large.json',
          false,
          new IOResult(),
          false,
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(closed).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})

it.each([
  [{ count: true }, /needle/, '0\n', 1],
  [{ count: true, invert_match: true }, /needle/, '100003\n', 0],
  [{ count: true }, /^$/, '100003\n', 0],
  [{ count: true, max_count: 17000 }, /^$/, '17000\n', 0],
  [{ count: true, before_context: 2, after_context: 2 }, /^$/, '100003\n', 0],
  [{ files_without_match: true }, /needle/, 'binary.so\n', 1],
  [{}, /needle/, '', 1],
] as const)('batches NUL runs without changing selection: %j', async (flags, pat, stdout, code) => {
  const data = new Uint8Array(100003)
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield data
  }
  const f = parseFlags(new FlagView(flags, specOf('grep')))
  const io = new IOResult()
  const reads = vi.spyOn(AsyncLineIterator.prototype, 'readline')
  try {
    const out = await materialize(grepInput(source(), pat, f, 'binary.so', false, io))
    expect(DEC.decode(out)).toBe(stdout)
    expect(io.exitCode).toBe(code)
    expect(io.stderr).toBeNull()
    expect(reads.mock.calls.length).toBeLessThan(20)
  } finally {
    reads.mockRestore()
  }
})

it.each([{}, { before_context: 2 }, { only_matching: true }])(
  'preserves offsets and context after empty lines: %j',
  async (flags) => {
    const data = ENC.encode('\n'.repeat(17003) + 'é needle\n')
    async function* source(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield data
    }
    const f = parseFlags(
      new FlagView({ ...flags, line_number: true, byte_offset: true }, specOf('grep')),
    )
    const io = new IOResult()
    const out = await materialize(grepInput(source(), /needle/, f, 'text', false, io))
    const expected =
      'only_matching' in flags
        ? '17004:17006:needle\n'
        : ('before_context' in flags ? '17002-17001-\n17003-17002-\n' : '') +
          '17004:17003:é needle\n'
    expect(DEC.decode(out)).toBe(expected)
    expect(io.exitCode).toBe(0)
  },
)

describe.each([
  /needle/,
  /needle/i,
  /needle|qqzzyy/,
  /nee.le/,
  /\bneedle\b/,
  /(?:needle)|(?:qqzzyy)/,
  /(?:needle|other)+/,
  /needle[0-9]+/,
  /(?<!\w)needle(?!\w)/i,
])('block search %s', (pat) => {
  it.each(['abcdefg\n', 'abcdefg\0', '\xffabcdef\n'])(
    'rejects short records by buffer without decoding each line: %j',
    async (record) => {
      const data = Buffer.from(record.repeat(40000), 'latin1')
      const original = Buffer.from(data)
      async function* source(): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        yield data
      }
      const reads = vi.spyOn(AsyncLineIterator.prototype, 'readline')
      try {
        const f = parseFlags(new FlagView({ count: true }, specOf('grep')))
        const io = new IOResult()
        expect(DEC.decode(await materialize(grepInput(source(), pat, f, 'f', false, io)))).toBe(
          '0\n',
        )
        expect(io.exitCode).toBe(1)
        expect(io.stderr).toBeNull()
        expect(reads.mock.calls.length).toBeLessThan(50)
        expect(data).toEqual(original)
      } finally {
        reads.mockRestore()
      }
    },
  )
})

describe.each([
  [7, /needle/],
  [16384, /needle/],
  [PROBE_BLOCK_BYTES, /needle/],
  [7, /needle|qqzzyy/],
  [16384, /needle/i],
  [PROBE_BLOCK_BYTES, /nee.le/],
  [7, /\bneedle\b/],
  [16384, /(?<!\w)needle(?!\w)/i],
] as const)('prefilter at chunk size %i for %s', (size, pat) => {
  it.each([
    {},
    { count: true },
    { quiet: true },
    { files_with_matches: true },
    { files_without_match: true },
    { max_count: 1 },
    { count: true, max_count: 1 },
    { line_number: true, byte_offset: true },
    { line_number: true, byte_offset: true, only_matching: true },
    { count: true, invert_match: true },
    { before_context: 2, after_context: 1, line_number: true, byte_offset: true },
  ])('preserves the unfiltered scanner results for %j', async (flags) => {
    const data = Buffer.concat([
      Buffer.from('abcdefg\n'.repeat(2100)),
      Buffer.from([0xff, 0, 10]),
      Buffer.from('é needle 😀\n' + 'abcdefg\n'.repeat(2100) + 'needle needle'),
    ])
    for (const mode of ['binary', 'text', 'without-match']) {
      async function* source(): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
      }
      const f = parseFlags(new FlagView({ binary_files: mode, ...flags }, specOf('grep')))
      const fast = new IOResult()
      const slow = new IOResult()
      const skip = vi
        .spyOn(AsyncLineIterator.prototype, 'skipNonmatchingLines')
        .mockReturnValue([0, 0])
      const expected = await materialize(grepInput(source(), pat, f, 'f', true, slow))
      skip.mockRestore()
      const actual = await materialize(grepInput(source(), pat, f, 'f', true, fast))
      expect([actual, fast.stderr, fast.exitCode]).toEqual([expected, slow.stderr, slow.exitCode])
    }
  })
})

it.each([
  /a\.b/,
  /a\+b/,
  /a\\b/,
  /a b/,
  /a.b/,
  /a.*b/,
  /(?:a|other)b?/,
  /a{0,2}b/,
  /(?:a|)b/,
  /(?:a|b)?/,
  /a(bc)?/,
  /s/iu,
  /k/iu,
  /i/i,
  /\bother\b/i,
  /(?=other)/,
  /(a)\1/,
  /\x61/,
  /a[\]x]b/,
  /a[^x]+b/,
  /^a/,
  /b$/,
  /[ab]/,
  /a|b/,
  /\w/,
  /(?:)/,
  /k/i,
  /a/g,
  /a/y,
  /é/,
  /needle|other/i,
  /nee.le/,
  /\bneedle\b/,
  /needleX?/,
  /s|k|i/i,
  /needle|other/iu,
  /(?<!\w)needle(?!\w)/i,
  /(?<name>need)le/,
])('does not mistake regex syntax or Unicode for an ASCII literal: %s', async (pat) => {
  const data = ENC.encode(
    'other\n'.repeat(3000) +
      'a.b\na+b\na\\b\na b\nab\né\nK\nk\nſ\nS\nİ\nı\nI\nNEEDLE\nneedleX\nneedle',
  )
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield data
  }
  const f = parseFlags(new FlagView({ line_number: true, byte_offset: true }, specOf('grep')))
  const fast = new IOResult()
  const slow = new IOResult()
  const skip = vi.spyOn(AsyncLineIterator.prototype, 'skipNonmatchingLines').mockReturnValue([0, 0])
  const expected = await materialize(
    grepInput(source(), new RegExp(pat.source, pat.flags), f, 'f', false, slow),
  )
  skip.mockRestore()
  const actual = await materialize(grepInput(source(), pat, f, 'f', false, fast))
  expect([actual, fast.stderr, fast.exitCode]).toEqual([expected, slow.stderr, slow.exitCode])
})

it('allows timer cancellation while skipping nonmatching buffers', async () => {
  const controller = new AbortController()
  const data = ENC.encode('abcdefg\n'.repeat(8192))
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      timer = setTimeout(() => {
        controller.abort()
      }, 0)
      for (;;) yield data
    } finally {
      closed = true
    }
  }
  try {
    const f = parseFlags(new FlagView({ count: true }, specOf('grep')))
    await expect(
      materialize(
        grepInput(source(), /needle/, f, 'f', false, new IOResult(), false, controller.signal),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(closed).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})

it.each([
  [{}, 'a', [...ENC.encode('a1\néa2\n')], 'grep: f: binary file matches\n'],
  [{ args_I: true }, 'a', [...ENC.encode('a1\néa2\n')], ''],
  [{ text: true }, 'a', [...ENC.encode('a1\na'), 0xff, ...ENC.encode('\néa2\n')], ''],
  [{ count: true }, 'a.', [...ENC.encode('2\n')], ''],
  [{ only_matching: true, byte_offset: true }, '2', [...ENC.encode('9:2\n')], ''],
] as const)(
  'a UTF-8 scan leaves out a line no character owns: %j %s',
  async (flags, pattern, stdout, stderr) => {
    async function* source(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield new Uint8Array([...ENC.encode('a1\na'), 0xff, ...ENC.encode('\néa2\n')])
    }
    const f = parseFlags(new FlagView(flags, specOf('grep')))
    const io = new IOResult({ exitCode: 1 })
    const pat = compilePerl(pattern, false, false, true)
    const out = await materialize(
      grepInput(source(), pat, f, 'f', false, io, false, undefined, true),
    )
    expect([...out]).toEqual([...stdout])
    expect(DEC.decode((io.stderr as Uint8Array | null) ?? undefined)).toBe(stderr)
    expect(io.exitCode).toBe(0)
  },
)
