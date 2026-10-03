import { expect, it } from 'vitest'
import { MountMode } from '../../../../../types.ts'
import { RAMVFS } from '../../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../../workspace/fixtures/workspace_fixture.ts'

const DEC = new TextDecoder()

it('relay tee checks every output before writing any', async () => {
  const ws = new Workspace(
    { '/a': new RAMVFS(), '/b': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const result = await ws.shell('printf x | tee --output-error=exit /a/one /b/nope/two /a/three')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stdout)).toBe('')
    expect(DEC.decode(result.stderr)).toBe('tee: /b/nope/two: No such file or directory\n')
    const listing = await ws.shell('ls /a; cat /a/one; printf y | tee /a/one /b/two')
    expect(DEC.decode(listing.stdout)).toBe('one\ny')
    expect(DEC.decode((await ws.shell('cat /a/one /b/two')).stdout)).toBe('yy')
  } finally {
    await ws.close()
  }
})
