import { describe, expect, it } from 'vitest'
import { RAMAccessor } from '../accessor/ram.ts'
import { RAM_IO } from '../commands/builtin/ram/io.ts'
import { PathSpec } from '../types.ts'
import { VFSAdapter } from './adapter.ts'
import { RAMStore } from './ram/store.ts'
import { checkReadContract, type ReadFixture } from './testing.ts'

const FILE = new PathSpec({ virtual: '/data/a.txt', directory: '/data', vfsPath: 'a.txt' })
const fixture: ReadFixture = {
  file: FILE,
  directory: new PathSpec({ virtual: '/data', directory: '/', vfsPath: '' }),
  missing: new PathSpec({ virtual: '/data/missing', directory: '/data', vfsPath: 'missing' }),
  content: new TextEncoder().encode('é: hello\n'),
}

describe('adapter conformance', () => {
  it.each([false, true])('checks builtin and minimal adapters, native=%s', async (native) => {
    const accessor = new RAMAccessor(new RAMStore())
    await RAM_IO.write?.(accessor, FILE, fixture.content)
    const adapter = native
      ? RAM_IO
      : new VFSAdapter({
          read: {
            readdir: RAM_IO.readdir,
            readBytes: RAM_IO.readBytes,
            stat: RAM_IO.stat,
          },
        })
    await checkReadContract(adapter, accessor, fixture)
  })

  it('catches a range callback treating size as end', async () => {
    const accessor = new RAMAccessor(new RAMStore())
    await RAM_IO.write?.(accessor, FILE, fixture.content)
    await expect(
      checkReadContract(
        {
          ...RAM_IO,
          readRange: (_a, _p, _i, offset, size) =>
            Promise.resolve(fixture.content.slice(offset, size ?? undefined)),
        },
        accessor,
        fixture,
      ),
    ).rejects.toThrow('offset and byte count')
  })

  it('propagates permission failures', async () => {
    const accessor = new RAMAccessor(new RAMStore())
    await expect(
      checkReadContract(
        { ...RAM_IO, readBytes: () => Promise.reject(new Error('denied')) },
        accessor,
        fixture,
      ),
    ).rejects.toThrow('denied')
  })
})
