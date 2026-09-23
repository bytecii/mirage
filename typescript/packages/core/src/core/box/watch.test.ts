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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, listFolderItems: vi.fn(), eventsNow: vi.fn(), eventsSince: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { FileChangeKind, PathSpec, type Delta } from '../../types.ts'
import * as api from './api.ts'
import type { BoxEvent, BoxItem } from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { BoxDeltaHook, BoxEventHook } from './watch.ts'

const STUB_TM = {} as BoxTokenManager
const ALL_FILES = { type: 'folder' as const, id: '0', name: 'All Files' }
const TEAM = { type: 'folder' as const, id: '10', name: 'team' }
type Parent = typeof ALL_FILES

function accessor(rootFolderId?: string): BoxAccessor {
  return new BoxAccessor({
    tokenManager: STUB_TM,
    ...(rootFolderId === undefined ? {} : { rootFolderId }),
  })
}

function root(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/box' : `/box/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

function file(id: string, name: string, sha1: string, ...parents: Parent[]): BoxItem {
  return {
    type: 'file',
    id,
    name,
    sha1,
    size: 4,
    modified_at: '2026-09-20T10:00:00-07:00',
    path_collection: { total_count: parents.length + 1, entries: [ALL_FILES, ...parents] },
  } as BoxItem
}

function folder(id: string, name: string, ...parents: Parent[]): BoxItem {
  return {
    type: 'folder',
    id,
    name,
    path_collection: { total_count: parents.length + 1, entries: [ALL_FILES, ...parents] },
  } as BoxItem
}

function event(eventType: string, source: BoxItem): BoxEvent {
  return { type: 'event', event_id: `${eventType}-${source.id}`, event_type: eventType, source }
}

class FakeBox {
  folders: Record<string, BoxItem[]>
  pending: BoxEvent[] = []
  position = 100
  calls: string[] = []

  constructor(folders: Record<string, BoxItem[]>) {
    this.folders = folders
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId) => {
      this.calls.push(`list ${folderId}`)
      return Promise.resolve(this.folders[folderId] ?? [])
    })
    vi.mocked(api.eventsNow).mockImplementation(() => {
      this.calls.push('now')
      return Promise.resolve(String(this.position))
    })
    vi.mocked(api.eventsSince).mockImplementation((_tm, position) => {
      this.calls.push(`since ${position}`)
      const entries = this.pending
      this.pending = []
      this.position += entries.length
      return Promise.resolve({ entries, position: String(this.position) })
    })
  }
}

function saved(delta: Delta): Record<string, unknown> {
  return JSON.parse(delta.checkpoint ?? '{}') as Record<string, unknown>
}

function kinds(delta: Delta): string[] {
  return delta.changes.map((c) => `${c.kind} ${c.path.virtual}`).sort()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BoxDeltaHook', () => {
  it('reads the stream head before walking on a baseline', async () => {
    const fake = new FakeBox({ '0': [file('1', 'a.txt', 's1')] })
    const delta = await new BoxDeltaHook(accessor()).pull(root(), null)
    expect(delta.changes).toEqual([])
    expect(fake.calls).toEqual(['now', 'list 0'])
    expect(saved(delta).p).toBe('100')
  })

  it('costs one events read and no listing when idle', async () => {
    const fake = new FakeBox({ '0': [folder('10', 'team'), file('1', 'a.txt', 's1')] })
    const hook = new BoxDeltaHook(accessor())
    const base = await hook.pull(root(), null)
    fake.calls = []
    const delta = await hook.pull(root(), base.checkpoint)
    expect(delta.changes).toEqual([])
    expect(fake.calls).toEqual(['since 100'])
  })

  it('classifies create, update and delete from events', async () => {
    const fake = new FakeBox({ '0': [file('1', 'a.txt', 's1'), file('2', 'b.txt', 's2')] })
    const hook = new BoxDeltaHook(accessor())
    const base = await hook.pull(root(), null)
    fake.pending = [
      event('ITEM_UPLOAD', file('1', 'a.txt', 's1-v2')),
      event('ITEM_UPLOAD', file('3', 'c.txt', 's3')),
      event('ITEM_TRASH', file('2', 'b.txt', 's2')),
      event('ITEM_PREVIEW', file('1', 'a.txt', 's1-v2')),
    ]
    const delta = await hook.pull(root(), base.checkpoint)
    expect(kinds(delta)).toEqual(['create /box/c.txt', 'delete /box/b.txt', 'update /box/a.txt'])
    const created = delta.changes.find((c) => c.path.virtual === '/box/c.txt')
    expect(created?.metadata?.fingerprint).toBe('s3|4')
    expect(saved(delta).p).toBe('104')
  })

  it('reports nothing for the same bytes uploaded again', async () => {
    const fake = new FakeBox({ '0': [file('1', 'a.txt', 's1')] })
    const hook = new BoxDeltaHook(accessor())
    const base = await hook.pull(root(), null)
    fake.pending = [event('ITEM_UPLOAD', file('1', 'a.txt', 's1'))]
    expect((await hook.pull(root(), base.checkpoint)).changes).toEqual([])
  })

  it('carries a renamed folder subtree and its ids', async () => {
    const fake = new FakeBox({
      '0': [folder('10', 'team')],
      '10': [file('1', 'a.txt', 's1', TEAM)],
    })
    const hook = new BoxDeltaHook(accessor())
    const base = await hook.pull(root(), null)
    fake.pending = [event('ITEM_RENAME', folder('10', 'crew'))]
    const delta = await hook.pull(root(), base.checkpoint)
    expect(kinds(delta)).toEqual([
      'create /box/crew',
      'create /box/crew/a.txt',
      'delete /box/team',
      'delete /box/team/a.txt',
    ])
    const crew = { type: 'folder' as const, id: '10', name: 'crew' }
    fake.pending = [event('ITEM_UPLOAD', file('1', 'a.txt', 's9', crew))]
    expect(kinds(await hook.pull(root(), delta.checkpoint))).toEqual(['update /box/crew/a.txt'])
  })

  it('walks a copied folder for its contents', async () => {
    const fake = new FakeBox({ '0': [] })
    const hook = new BoxDeltaHook(accessor())
    const base = await hook.pull(root(), null)
    const copy = { type: 'folder' as const, id: '20', name: 'copy' }
    fake.folders['20'] = [file('21', 'x.txt', 's21', copy)]
    fake.pending = [event('ITEM_COPY', folder('20', 'copy'))]
    expect(kinds(await hook.pull(root(), base.checkpoint))).toEqual([
      'create /box/copy',
      'create /box/copy/x.txt',
    ])
  })

  it('drops events outside the watch root', async () => {
    const fake = new FakeBox({ '0': [folder('10', 'team'), folder('11', 'other')], '10': [] })
    const hook = new BoxDeltaHook(accessor())
    const base = await hook.pull(root('team'), null)
    const other = { type: 'folder' as const, id: '11', name: 'other' }
    fake.pending = [
      event('ITEM_UPLOAD', file('5', 'n.txt', 's5', other)),
      event('ITEM_UPLOAD', file('6', 'm.txt', 's6', TEAM)),
    ]
    expect(kinds(await hook.pull(root('team'), base.checkpoint))).toEqual([
      'create /box/team/m.txt',
    ])
  })

  it('reports a move out of the mount root as a delete', async () => {
    const fake = new FakeBox({ '10': [file('1', 'a.txt', 's1', TEAM)] })
    const hook = new BoxDeltaHook(accessor('10'))
    const base = await hook.pull(root(), null)
    fake.pending = [event('ITEM_MOVE', file('1', 'a.txt', 's1'))]
    expect(kinds(await hook.pull(root(), base.checkpoint))).toEqual(['delete /box/a.txt'])
  })

  it('upgrades a listing-era checkpoint', async () => {
    new FakeBox({ '0': [file('1', 'a.txt', 's1')] })
    const old = JSON.stringify({ '/box/a.txt': 's0|4', '/box/gone.txt': 's2|4' })
    const delta = await new BoxDeltaHook(accessor()).pull(root(), old)
    expect(kinds(delta)).toEqual(['delete /box/gone.txt', 'update /box/a.txt'])
    expect(saved(delta)._box).toBe(1)
  })

  it('relists a checkpoint older than the replay window', async () => {
    const fake = new FakeBox({ '0': [file('1', 'a.txt', 's1')] })
    const hook = new BoxDeltaHook(accessor())
    const base = await hook.pull(root(), null)
    const stale = saved(base)
    stale.t = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    fake.folders['0'] = [file('1', 'a.txt', 's1-v2')]
    fake.calls = []
    const delta = await hook.pull(root(), JSON.stringify(stale))
    expect(fake.calls).toEqual(['now', 'list 0'])
    expect(kinds(delta)).toEqual(['update /box/a.txt'])
  })
})

describe('BoxEventHook', () => {
  async function mapped(hook: BoxEventHook, eventType: string, source: BoxItem): Promise<string[]> {
    const out = await hook.toEvents(root(), eventType, event(eventType, source) as never)
    return out.map(
      (c) =>
        `${c.kind} ${c.path.virtual}${c.previousPath === null ? '' : ` <- ${c.previousPath.virtual}`}`,
    )
  }

  it('tracks ids across events', async () => {
    const hook = new BoxEventHook(accessor())
    expect(await mapped(hook, 'ITEM_UPLOAD', file('1', 'a.txt', 's1'))).toEqual([
      'create /box/a.txt',
    ])
    expect(await mapped(hook, 'ITEM_UPLOAD', file('1', 'a.txt', 's2'))).toEqual([
      'update /box/a.txt',
    ])
    expect(await mapped(hook, 'ITEM_RENAME', file('1', 'b.txt', 's2'))).toEqual([
      'move /box/b.txt <- /box/a.txt',
    ])
    expect(await mapped(hook, 'ITEM_TRASH', file('1', 'b.txt', 's2'))).toEqual([
      'delete /box/b.txt',
    ])
  })

  it('maps a move of an unknown item to UNKNOWN on its parent', async () => {
    const hook = new BoxEventHook(accessor())
    expect(await mapped(hook, 'ITEM_MOVE', file('7', 'a.txt', 's7', TEAM))).toEqual([
      `${FileChangeKind.UNKNOWN} /box/team`,
    ])
  })

  it('ignores items outside the mount', async () => {
    const hook = new BoxEventHook(accessor('10'))
    const other = { type: 'folder' as const, id: '11', name: 'other' }
    expect(await mapped(hook, 'ITEM_UPLOAD', file('5', 'n.txt', 's5', other))).toEqual([])
    expect(await mapped(hook, 'ITEM_UPLOAD', file('6', 'm.txt', 's6', TEAM))).toEqual([
      'create /box/m.txt',
    ])
  })
})
