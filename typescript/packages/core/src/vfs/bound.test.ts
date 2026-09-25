import { expect, it } from 'vitest'
import { RAM_IO } from '../commands/builtin/ram/io.ts'
import { MountMode, PathSpec } from '../types.ts'
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { GenericVFS } from './generic.ts'
import { RAMVFS } from './ram/ram.ts'

it.each([false, true])('builtin and custom writes obey mount mode, custom=%s', async (custom) => {
  const builtin = new RAMVFS()
  const path = new PathSpec({ virtual: '/data/a', directory: '/data', vfsPath: 'a' })
  const before = new TextEncoder().encode('before')
  await builtin.writeFile(path, before)
  const vfs = custom
    ? new GenericVFS({ name: 'probe', accessor: builtin.accessor, io: RAM_IO })
    : builtin
  const ws = new Workspace(
    { '/data': vfs },
    { mode: MountMode.READ, shellParser: await getTestParser() },
  )
  try {
    const result = await ws.shell('echo after > /data/a')
    expect(result.exitCode).not.toBe(0)
    expect(await vfs.readFile(path)).toEqual(before)
  } finally {
    await ws.close()
    if (custom) await builtin.close()
  }
})
