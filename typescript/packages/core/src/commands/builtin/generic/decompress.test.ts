import { expect, it } from 'vitest'
import { yieldBytes } from '../../../io/stream.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { gzip } from '../../../utils/compress.ts'
import { decompressInputs } from './decompress.ts'

const enc = new TextEncoder()

it.each(
  ['gunzip', 'gzip', 'zcat'].flatMap((command) =>
    [null, 'x', '\x1f'].map((suffix) => ({ command, suffix })),
  ),
)('stops after fatal input: %j', async ({ command, suffix }) => {
  const reads: string[] = []
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    reads.push(path.virtual)
    yield suffix === null
      ? new Uint8Array()
      : new Uint8Array([...(await gzip(enc.encode('hello'))), ...enc.encode(suffix)])
  }
  async function* stdin(): AsyncIterable<Uint8Array> {
    reads.push('stdin')
    yield await gzip(enc.encode('hello'))
  }
  const paths = ['/a/bad.gz', '/b/missing.gz', '-'].map((p) => PathSpec.fromStrPath(p))
  const [body, io] = await decompressInputs(paths, read, {
    command,
    stdin: stdin(),
    toStdout: true,
  })
  expect(await materialize(body)).toEqual(enc.encode(suffix === null ? '' : 'hello'))
  expect(reads).toEqual(['/a/bad.gz'])
  expect(io.exitCode).toBe(1)
  expect(new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
    `${command}: /a/bad.gz: unexpected end of file\n`,
  )
})

it('retains in-place output on a trailing warning and continues', async () => {
  const files = new Map<string, Uint8Array>(
    Object.entries({
      '/data/a.gz': new Uint8Array([...(await gzip(enc.encode('hello'))), ...enc.encode('junk')]),
      '/data/b.gz': await gzip(enc.encode('world')),
    }),
  )
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    const data = files.get(path.virtual)
    if (data === undefined) throw new Error('missing test fixture')
    yield* yieldBytes(data)
  }
  const paths = [...files.keys()].map((p) => PathSpec.fromStrPath(p))
  const [body, io] = await decompressInputs(paths, read, {
    command: 'gunzip',
    stdin: null,
    write: (path, data) => {
      files.set(path.virtual, data)
      return Promise.resolve()
    },
    unlink: (path) => {
      files.delete(path.virtual)
      return Promise.resolve()
    },
  })
  expect(body).toBeNull()
  expect(Object.fromEntries(files)).toEqual({
    '/data/a': enc.encode('hello'),
    '/data/b': enc.encode('world'),
  })
  expect(io.exitCode).toBe(2)
  expect(new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
    'gunzip: /data/a.gz: decompression OK, trailing garbage ignored\n',
  )
})
