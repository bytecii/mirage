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

import { chmodSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapacityState, FileType, PathSpec, VFSName } from '@struktoai/mirage-core/types'
import { spec, tmpRoot } from '../../test-utils.ts'
import { DiskVFS } from './disk.ts'

let root: string
let cleanup: () => void
let res: DiskVFS

beforeEach(async () => {
  ;({ root, cleanup } = tmpRoot('mirage-diskvfs-'))
  res = new DiskVFS({ root })
  await res.open()
})

afterEach(() => {
  cleanup()
})

describe('DiskVFS — identity', () => {
  it('exposes kind, prompt, root', () => {
    expect(res.kind).toBe(VFSName.DISK)
    expect(typeof res.prompt).toBe('string')
    expect(res.root).toBe(root)
  })

  it('ops() returns DISK_OPS', () => {
    expect(res.ops().length).toBeGreaterThan(0)
  })

  it('commands() returns RAM_COMMANDS', () => {
    expect(res.commands().length).toBeGreaterThan(0)
  })

  it('statfs reports a real quota (df numbers, not fabricated)', async () => {
    const cap = await res.statfs()
    expect(cap.state).toBe(CapacityState.QUOTA)
    expect(cap.total ?? 0).toBeGreaterThan(0)
    expect(cap.available ?? -1).toBeGreaterThanOrEqual(0)
    expect(cap.inodes ?? 0).toBeGreaterThan(0)
  })
})

describe('DiskVFS — fs methods', () => {
  it('writeFile + readFile round-trip', async () => {
    await res.writeFile(spec('/x.txt'), new TextEncoder().encode('hello'))
    const data = await res.readFile(spec('/x.txt'))
    expect(new TextDecoder().decode(data)).toBe('hello')
  })

  it('writeFile does not create parent dirs', async () => {
    // A write is not `mkdir -p`: GNU reports ENOENT on a missing parent.
    await expect(
      res.writeFile(spec('/a/b/c.txt'), new TextEncoder().encode('deep')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('appendFile concatenates', async () => {
    await res.writeFile(spec('/a.txt'), new TextEncoder().encode('1'))
    await res.appendFile(spec('/a.txt'), new TextEncoder().encode('2'))
    expect(new TextDecoder().decode(await res.readFile(spec('/a.txt')))).toBe('12')
  })

  it('readdir returns full virtual paths sorted', async () => {
    await res.writeFile(spec('/b.txt'), new Uint8Array())
    await res.writeFile(spec('/a.txt'), new Uint8Array())
    expect(await res.readdir(spec('/'))).toEqual(['/a.txt', '/b.txt'])
  })

  it('stat distinguishes files and directories', async () => {
    await res.writeFile(spec('/file.txt'), new TextEncoder().encode('x'))
    await res.mkdir(spec('/dir'))
    const f = await res.stat(spec('/file.txt'))
    expect(f.size).toBe(1)
    expect(f.type).not.toBe(FileType.DIRECTORY)
    const d = await res.stat(spec('/dir'))
    expect(d.type).toBe(FileType.DIRECTORY)
  })

  it('exists() is truthy for created files and falsy for missing', async () => {
    await res.writeFile(spec('/p.txt'), new Uint8Array())
    expect(await res.exists(spec('/p.txt'))).toBe(true)
    expect(await res.exists(spec('/nope.txt'))).toBe(false)
  })

  it('mkdir + rmdir', async () => {
    await res.mkdir(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(true)
    await res.rmdir(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(false)
  })

  it('unlink removes a file', async () => {
    await res.writeFile(spec('/x'), new Uint8Array())
    await res.unlink(spec('/x'))
    expect(await res.exists(spec('/x'))).toBe(false)
  })

  it('rename moves a file', async () => {
    await res.writeFile(spec('/a'), new TextEncoder().encode('A'))
    await res.rename(spec('/a'), spec('/b'))
    expect(await res.exists(spec('/a'))).toBe(false)
    expect(new TextDecoder().decode(await res.readFile(spec('/b')))).toBe('A')
  })

  it('copy duplicates a file', async () => {
    await res.writeFile(spec('/src'), new TextEncoder().encode('CP'))
    await res.copy(spec('/src'), spec('/dst'))
    expect(new TextDecoder().decode(await res.readFile(spec('/dst')))).toBe('CP')
  })

  it('truncate shrinks a file', async () => {
    await res.writeFile(spec('/t'), new TextEncoder().encode('hello'))
    await res.truncate(spec('/t'), 2)
    expect(new TextDecoder().decode(await res.readFile(spec('/t')))).toBe('he')
  })

  it('rmR removes a directory recursively', async () => {
    await res.mkdir(spec('/d'))
    await res.writeFile(spec('/d/x.txt'), new TextEncoder().encode('x'))
    await res.rmR(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(false)
  })

  it('du sums file sizes under a path', async () => {
    await res.mkdir(spec('/d'))
    await res.writeFile(spec('/d/a'), new Uint8Array([1, 2, 3]))
    await res.writeFile(spec('/d/b'), new Uint8Array([4, 5]))
    expect(await res.du(spec('/d'))).toBe(5)
  })

  it('streamPath yields file bytes', async () => {
    await res.writeFile(spec('/big'), new TextEncoder().encode('chunk'))
    const chunks: Uint8Array[] = []
    for await (const c of res.streamPath(spec('/big'))) chunks.push(c)
    expect(new TextDecoder().decode(chunks[0])).toBe('chunk')
  })

  it('find returns matching paths', async () => {
    await res.writeFile(spec('/a.json'), new Uint8Array())
    await res.writeFile(spec('/b.txt'), new Uint8Array())
    const found = await res.find(spec('/'), { name: '*.json' })
    expect(found).toEqual(['/a.json'])
  })
})

describe('DiskVFS — getState / loadState round-trip', () => {
  it('snapshots files', async () => {
    await res.writeFile(spec('/a.txt'), new TextEncoder().encode('A'))
    await res.mkdir(spec('/d'))
    await res.writeFile(spec('/d/b.txt'), new TextEncoder().encode('B'))

    const state = await res.getState()
    expect(Object.keys(state.files).sort()).toEqual(['a.txt', 'd/b.txt'])
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')

    const { root: root2, cleanup: c2 } = tmpRoot('mirage-diskvfs-load-')
    try {
      const res2 = new DiskVFS({ root: root2 })
      await res2.open()
      await res2.loadState(state)
      expect(new TextDecoder().decode(await res2.readFile(spec('/a.txt')))).toBe('A')
      expect(new TextDecoder().decode(await res2.readFile(spec('/d/b.txt')))).toBe('B')
    } finally {
      c2()
    }
  })

  it('preserves file mode across a state round-trip', async () => {
    await res.writeFile(spec('/f.txt'), new TextEncoder().encode('hi'))
    chmodSync(join(root, 'f.txt'), 0o640)
    const state = await res.getState()
    expect(state.modes?.['f.txt']).toBe(0o640)

    const { root: root2, cleanup: c2 } = tmpRoot('mirage-diskvfs-mode-')
    try {
      const res2 = new DiskVFS({ root: root2 })
      await res2.open()
      await res2.loadState(state)
      expect(statSync(join(root2, 'f.txt')).mode & 0o777).toBe(0o640)
    } finally {
      c2()
    }
  })
})

interface HostFixture {
  files: Record<string, string>
  directories: string[]
  symlinks: Record<string, string>
  visible_files: string[]
  hidden_paths: string[]
}

describe('DiskVFS — shared host-link contract', () => {
  let fixture: HostFixture
  let vfs: DiskVFS

  beforeEach(async () => {
    fixture = JSON.parse(
      await readFile(
        new URL('../../../../../../integ/fixtures/disk/host-links.json', import.meta.url),
        'utf8',
      ),
    ) as HostFixture
    for (const [relative, text] of Object.entries(fixture.files)) {
      const full = join(root, relative)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, text)
    }
    for (const relative of fixture.directories)
      await mkdir(join(root, relative), { recursive: true })
    for (const [relative, target] of Object.entries(fixture.symlinks))
      await symlink(target, join(root, relative))
    vfs = new DiskVFS({ root: join(root, 'root') })
    await vfs.open()
  })

  it('uses the same visible tree for snapshots, find, du and direct operations', async () => {
    expect(Object.keys((await vfs.getState()).files).sort()).toEqual(fixture.visible_files)
    expect(await vfs.find(spec('/'), { type: 'f' })).toEqual(
      fixture.visible_files.map((p) => '/' + p),
    )
    expect(await vfs.du(spec('/'))).toBe(13)
    for (const p of fixture.hidden_paths) {
      expect(await vfs.exists(spec(p))).toBe(false)
      await expect(vfs.readFile(spec(p))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        vfs.writeFile(spec(p), new TextEncoder().encode('changed')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(join(root, 'outside/secret.txt'), 'utf8')).toBe('outside\n')
  })

  it('keeps the same visible tree when the mount root is an alias', async () => {
    const alias = join(root, 'alias')
    await symlink(vfs.root, alias)
    const mounted = new DiskVFS({ root: alias })
    expect(await mounted.du(spec('/'))).toBe(13)
    expect(Object.keys((await mounted.getState()).files).sort()).toEqual(fixture.visible_files)
  })

  it('requires an exact copy destination', async () => {
    await expect(vfs.copy(spec('/plain.txt'), spec('/destination'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(await readFile(join(root, 'outside/secret.txt'), 'utf8')).toBe('outside\n')
  })

  it.each(['escape', 'escape-dir/secret.txt', 'destination/plain.txt', '../outside/secret.txt'])(
    'refuses restoring through %s',
    async (relative) => {
      const before = statSync(join(root, 'outside/secret.txt')).mode
      await expect(
        vfs.loadState({
          type: 'disk',
          files: { [relative]: new TextEncoder().encode('changed') },
          modes: { [relative]: 0o600 },
        }),
      ).rejects.toThrow()
      expect(statSync(join(root, 'outside/secret.txt')).mode).toBe(before)
      expect(await readFile(join(root, 'outside/secret.txt'), 'utf8')).toBe('outside\n')
    },
  )

  it('creates missing restore parents and applies modes', async () => {
    await vfs.loadState({
      type: 'disk',
      files: { 'new/deep/file': new TextEncoder().encode('restored') },
      modes: { 'new/deep/file': 0o640 },
    })
    const target = join(root, 'root/new/deep/file')
    expect(await readFile(target, 'utf8')).toBe('restored')
    expect(statSync(target).mode & 0o777).toBe(0o640)
  })

  it('refuses absolute snapshot keys', async () => {
    const outside = join(root, 'outside/secret.txt')
    await expect(
      vfs.loadState({ type: 'disk', files: { [outside]: new TextEncoder().encode('changed') } }),
    ).rejects.toThrow(/relative/)
    expect(await readFile(outside, 'utf8')).toBe('outside\n')
  })

  it('does not stat unreadable symlink targets during snapshot capture', async () => {
    await chmod(join(root, 'outside'), 0)
    try {
      expect(Object.keys((await vfs.getState()).files).sort()).toEqual(fixture.visible_files)
    } finally {
      await chmod(join(root, 'outside'), 0o700)
    }
  })

  it('does not report unreadable trees as absent or empty', async () => {
    await chmod(join(root, 'root/lib'), 0)
    try {
      const file = PathSpec.fromStrPath('/data/lib/a.txt', 'lib/a.txt')
      const directory = PathSpec.fromStrPath('/data/lib', 'lib')
      await expect(vfs.exists(file)).rejects.toMatchObject({
        code: 'EACCES',
        message: file.virtual,
      })
      for (const operation of [
        () => vfs.find(directory),
        () => vfs.du(directory),
        () => vfs.readdir(directory),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: 'EACCES',
          message: directory.virtual,
        })
      }
    } finally {
      await chmod(join(root, 'root/lib'), 0o700)
    }
  })
})
