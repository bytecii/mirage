import { expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { runWc } from './wc.ts'

it.each([
  [{ lines: true }, '      0 /a/dir\n      1 /b/name with spaces\n      1 total\n'],
  [{ lines: true, total: 'only' }, '1\n'],
  [{ lines: true, total: 'never' }, '      0 /a/dir\n      1 /b/name with spaces\n'],
] as [Record<string, FlagValue>, string][])(
  'preserves operand type and whitespace: %j',
  async (flags, expected) => {
    const dispatch = vi.fn((op: string, path: PathSpec): Promise<[unknown, IOResult]> => {
      if (op === 'stat')
        return Promise.resolve([
          new FileStat({
            name: path.virtual,
            type: path.virtual === '/a/dir' ? FileType.DIRECTORY : FileType.FILE,
          }),
          new IOResult(),
        ])
      expect(path.virtual).not.toBe('/a/dir')
      return Promise.resolve([new TextEncoder().encode('hello\n'), new IOResult()])
    })
    const paths = ['/a/dir', '/b/name with spaces'].map((p) => PathSpec.fromStrPath(p))
    const [body, io] = await runWc(paths, flags, dispatch)
    expect(new TextDecoder().decode(await materialize(body))).toBe(expected)
    expect(io.reads).toEqual({ '/b/name with spaces': new TextEncoder().encode('hello\n') })
    expect(io.cache).toEqual(['/b/name with spaces'])
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(await materialize(io.stderr))).toBe(
      'wc: /a/dir: Is a directory\n',
    )
  },
)

it('rejects an invalid total before dispatch', async () => {
  const dispatch = vi.fn(
    (): Promise<[unknown, IOResult]> => Promise.resolve([null, new IOResult()]),
  )
  const [, io] = await runWc([PathSpec.fromStrPath('/a/x')], { total: 'bogus' }, dispatch)
  expect(io.exitCode).toBe(1)
  expect(new TextDecoder().decode(await materialize(io.stderr))).toContain(
    "invalid argument 'bogus'",
  )
  expect(dispatch).not.toHaveBeenCalled()
})
