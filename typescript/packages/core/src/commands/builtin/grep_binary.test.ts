import { describe, expect, it } from 'vitest'
import { specOf } from '../spec/builtins.ts'
import { FlagView } from '../spec/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { parseFlags } from './generic/grep.ts'
import { grepInput } from './grep_binary.ts'
import { UsageError } from '../errors.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe.each([1, 2, 7, 1024, 32768])('binary grep with %i-byte backend chunks', (size) => {
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
      const f = parseFlags(new FlagView({ binary_files: mode, n: true }, specOf('grep')))
      const io = new IOResult({ exitCode: 1 })
      const out = await materialize(grepInput(source(), /needle/, f, '/remote/data.pdf', false, io))
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
})

it.each([{ args_I: true }, { q: true }, {}])('bounds remote reads for %j', async (flags) => {
  const block = new Uint8Array(32768).fill(120)
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

it('does not prefetch remote rows beyond max-count', async () => {
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      yield ENC.encode('needle\n')
      throw new Error('read past the requested match')
    } finally {
      closed = true
    }
  }
  const f = parseFlags(new FlagView({ m: 1 }, specOf('grep')))
  const io = new IOResult()
  expect(
    await materialize(grepInput(source(), /needle/, f, '/remote/rows.jsonl', false, io)),
  ).toEqual(ENC.encode('needle\n'))
  expect(io.exitCode).toBe(0)
  expect(closed).toBe(true)
})

it.each([
  [{ B: '-1' }, '-1'],
  [{ A: '-1' }, '-1'],
  [{ C: '-1' }, '-1'],
  [{ A: 'x' }, 'x'],
  [{ B: '1.5' }, '1.5'],
  [{ B: -1 }, '-1'],
  [{ B: '-1', A: 'x' }, '-1'],
  [{ A: 'x', B: '-1' }, 'x'],
])('rejects an invalid context length %j', (flags, shown) => {
  expect(() => parseFlags(new FlagView(flags, specOf('grep')))).toThrow(
    new UsageError(`grep: ${shown}: invalid context length argument`),
  )
})

it.each([{ B: '-0' }, { A: '0' }, { C: 2 }])('accepts context length %j', (flags) => {
  expect(() => parseFlags(new FlagView(flags, specOf('grep')))).not.toThrow()
})

it.each(['', 'bogus'])('rejects invalid binary mode %j', (value) => {
  expect(() => parseFlags(new FlagView({ binary_files: value }, specOf('grep')))).toThrow(
    'unknown binary-files type',
  )
})

describe.each([1024, 32768, 65536])('late NUL with %i-byte backend chunks', (size) => {
  describe.each(['', '\n'])('preceding block ends with %j', (lineEnd) => {
    describe.each([false, true])('count-only %j', (countOnly) => {
      it.each([{ args_I: true }, { binary_files: 'without-match' }])(
        'discards earlier matches with %j',
        async (binaryFlag) => {
          const data = ENC.encode(
            'needle\n' + 'x'.repeat(32761 - lineEnd.length) + lineEnd + '\0tail\n',
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
          const f = parseFlags(new FlagView({ ...binaryFlag, c: countOnly }, specOf('grep')))
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
})

it.each([
  [{ m: 1, c: true }, '1\n'],
  [{ q: true }, ''],
  [{ args_l: true }, '/remote/rows.jsonl\n'],
] as const)('does not read ahead after without-match early stop %j', async (flags, expected) => {
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      yield ENC.encode('needle\n')
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
