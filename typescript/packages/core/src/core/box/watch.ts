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

import type { BoxAccessor } from '../../accessor/box.ts'
import {
  Delta,
  FileChangeKind,
  FileEvent,
  FileMetadata,
  type JsonValue,
  type PathSpec,
  type WalkEntry,
} from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { DIR_FINGERPRINT } from '../../watch/constants.ts'
import { specFor } from '../../watch/delta.ts'
import { eventAt, field, virtualOf } from '../../watch/events.ts'
import { statFingerprint } from '../../watch/fingerprint.ts'
import {
  absentOn404,
  eventsNow,
  eventsSince,
  listFolderItems,
  type BoxEvent,
  type BoxSearchItem,
} from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { EVENT_REPLAY_DAYS, EVENT_STREAM, PLACE_EVENTS, TRASH_EVENTS } from './constants.ts'
import { mountRelativeKey, pathParts, resolveItem } from './resolve.ts'

const NATIVE = 1
const DAY_MS = 24 * 60 * 60 * 1000

interface BoxSource extends BoxSearchItem {
  sha1?: string
  size?: number
  modified_at?: string
}

/**
 * One walk row for a Box item, fingerprinted the way stat does.
 *
 * The fingerprint matches what `ReaddirWalk` built from Box stat, so a
 * listing-era checkpoint upgrades without reporting every file.
 */
function entryOf(
  virtual: string,
  item: { type: string; sha1?: string; size?: number; modified_at?: string },
): WalkEntry {
  if (item.type === 'folder') return { virtual, isDir: true, fingerprint: null }
  const modified =
    item.modified_at !== undefined && item.modified_at !== '' ? item.modified_at : null
  const size = typeof item.size === 'number' ? item.size : null
  const sha1 = item.sha1 !== undefined && item.sha1 !== '' ? item.sha1 : null
  return {
    virtual,
    isDir: false,
    fingerprint: statFingerprint(sha1 ?? modified, modified, size),
    size,
    modified,
  }
}

/**
 * Yield [box id, entry] for everything under one folder.
 *
 * Web links are skipped, as readdir hides them. A folder removed mid-walk is
 * skipped; the next pull settles it.
 */
async function* walk(
  tm: BoxTokenManager,
  folderId: string,
  virtual: string,
): AsyncGenerator<[string, WalkEntry]> {
  let items
  try {
    items = await absentOn404(virtual, () => listFolderItems(tm, folderId))
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return
    throw error
  }
  for (const item of items) {
    if (item.type !== 'file' && item.type !== 'folder') continue
    const child = `${virtual.replace(/\/+$/, '')}/${item.name}`
    yield [item.id, entryOf(child, item)]
    if (item.type === 'folder') yield* walk(tm, item.id, child)
  }
}

function inside(key: string, virtual: string): boolean {
  return key === virtual || key.startsWith(`${virtual}/`)
}

/**
 * The last applied snapshot, plus the Box id behind each path.
 *
 * Events name items by id, and a move or trash event does not carry where the
 * item was, so the id map is what finds the old path.
 */
class Tree {
  snapshot: Record<string, string>
  ids: Record<string, string>
  readonly entries = new Map<string, WalkEntry>()

  constructor(snapshot: Record<string, string>, ids: Record<string, string>) {
    this.snapshot = { ...snapshot }
    this.ids = { ...ids }
  }

  put(boxId: string, entry: WalkEntry): void {
    this.snapshot[entry.virtual] = entry.isDir ? DIR_FINGERPRINT : (entry.fingerprint ?? '')
    this.ids[boxId] = entry.virtual
    this.entries.set(entry.virtual, entry)
  }

  drop(virtual: string): void {
    this.snapshot = Object.fromEntries(
      Object.entries(this.snapshot).filter(([key]) => !inside(key, virtual)),
    )
    this.ids = Object.fromEntries(
      Object.entries(this.ids).filter(([, key]) => !inside(key, virtual)),
    )
  }

  move(old: string, next: string): void {
    const rebase = (key: string): string => (inside(key, old) ? next + key.slice(old.length) : key)
    this.snapshot = Object.fromEntries(
      Object.entries(this.snapshot).map(([key, value]) => [rebase(key), value]),
    )
    this.ids = Object.fromEntries(Object.entries(this.ids).map(([id, key]) => [id, rebase(key)]))
  }
}

function sorted(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(record).sort(compareCodePoints)) {
    const value = record[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

function encode(position: string, observed: Date, tree: Tree): string {
  return JSON.stringify({
    _box: NATIVE,
    i: sorted(tree.ids),
    p: position,
    s: sorted(tree.snapshot),
    t: observed.toISOString(),
  })
}

interface Decoded {
  position: string | null
  pulled: Date | null
  snapshot: Record<string, string> | null
  ids: Record<string, string>
  native: boolean
}

/**
 * A listing-era checkpoint is a bare `{virtual: fingerprint}` map with no
 * stream position; it is diffed against a fresh walk once and upgraded.
 */
function decode(checkpoint: string | null): Decoded {
  const none: Decoded = { position: null, pulled: null, snapshot: null, ids: {}, native: false }
  if (checkpoint === null) return none
  const parsed: unknown = JSON.parse(checkpoint)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return none
  const data = parsed as Record<string, unknown>
  if (data._box === NATIVE) {
    return {
      position: data.p as string,
      pulled: new Date(data.t as string),
      snapshot: data.s as Record<string, string>,
      ids: data.i as Record<string, string>,
      native: true,
    }
  }
  return { ...none, snapshot: data as Record<string, string> }
}

function diff(
  root: PathSpec,
  previous: Record<string, string>,
  tree: Tree,
  observed: Date,
): FileEvent[] {
  const keys = [...new Set([...Object.keys(tree.snapshot), ...Object.keys(previous)])].sort(
    compareCodePoints,
  )
  const changes: FileEvent[] = []
  for (const virtual of keys) {
    const old = previous[virtual]
    const next = tree.snapshot[virtual]
    if (old === next) continue
    const kind =
      old === undefined
        ? FileChangeKind.CREATE
        : next === undefined
          ? FileChangeKind.DELETE
          : FileChangeKind.UPDATE
    const entry = tree.entries.get(virtual)
    const metadata =
      entry !== undefined && !entry.isDir && kind !== FileChangeKind.DELETE
        ? new FileMetadata({
            fingerprint: entry.fingerprint,
            size: entry.size ?? null,
            modified: entry.modified ?? null,
          })
        : null
    changes.push(
      new FileEvent({ kind, path: specFor(root, virtual), timestamp: observed, metadata }),
    )
  }
  return changes
}

/**
 * The file or folder an event is about, or null.
 *
 * User events carry the full item as `source`, with the `path_collection`
 * that places it. Web links, users and collaborations are not paths on the
 * mount.
 */
function sourceOf(event: JsonValue): BoxSource | null {
  const source = field(event, 'source')
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
  if (source.type !== 'file' && source.type !== 'folder') return null
  if (typeof source.id !== 'string' || source.id === '') return null
  return source as unknown as BoxSource
}

/**
 * Box `/events` pull, with the per-folder walk as reset.
 *
 * The user event stream is account-wide, so every event is placed through its
 * `path_collection` and dropped unless it lands under the watch root. A move
 * arrives as one `ITEM_MOVE` (or `ITEM_RENAME`) naming only the new location,
 * which is why the checkpoint keeps the Box id of each path next to the
 * snapshot: the id finds the old path, and a moved folder carries its subtree
 * with it. A folder that shows up already populated (a copy, a restore, a move
 * in from outside the root) is walked, since Box sends one event for the
 * folder and none for what is inside.
 *
 * Box never refuses an old `stream_position`: user events are kept for two
 * weeks to two months and a stale position replays whatever is left. So there
 * is no error to reset on, and a checkpoint older than `EVENT_REPLAY_DAYS`
 * relists instead. The relist reads the stream head before walking, so a
 * write that lands mid-walk is replayed by the next pull rather than lost; the
 * fingerprint diff discards the repeat.
 */
export class BoxDeltaHook implements DeltaHook {
  private readonly accessor: BoxAccessor

  constructor(accessor: BoxAccessor) {
    this.accessor = accessor
  }

  private virtualOf(root: PathSpec, item: BoxSource): string | null {
    const relative = mountRelativeKey(item, this.accessor.rootFolderId)
    if (relative === null) return null
    const virtual = virtualOf(root, relative)
    if (!virtual.startsWith(`${root.virtual.replace(/\/+$/, '')}/`)) return null
    return virtual
  }

  private async rootFolder(root: PathSpec): Promise<string | null> {
    const parts = pathParts(root)
    if (parts.length === 0) return this.accessor.rootFolderId
    let item
    try {
      item = await absentOn404(root.virtual, () => resolveItem(this.accessor, parts))
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ENOENT') return null
      throw error
    }
    if (item?.type !== 'folder') return null
    return item.id
  }

  private async relist(
    root: PathSpec,
    previous: Record<string, string> | null,
    observed: Date,
  ): Promise<Delta> {
    const tm = this.accessor.tokenManager
    const position = await eventsNow(tm, EVENT_STREAM)
    const tree = new Tree({}, {})
    const folder = await this.rootFolder(root)
    if (folder !== null) {
      for await (const [boxId, entry] of walk(tm, folder, root.virtual)) tree.put(boxId, entry)
    }
    const changes = previous === null ? [] : diff(root, previous, tree, observed)
    return new Delta({ changes, checkpoint: encode(position, observed, tree) })
  }

  private async apply(root: PathSpec, tree: Tree, event: BoxEvent): Promise<void> {
    const source = sourceOf(event as JsonValue)
    if (source === null) return
    const kind = event.event_type ?? ''
    const old = tree.ids[source.id]
    if (TRASH_EVENTS.has(kind)) {
      if (old !== undefined) tree.drop(old)
      return
    }
    if (!PLACE_EVENTS.has(kind)) return
    const virtual = this.virtualOf(root, source)
    const isDir = source.type === 'folder'
    if (old !== undefined && old !== virtual) {
      if (virtual !== null && isDir) {
        tree.move(old, virtual)
        return
      }
      tree.drop(old)
    }
    if (virtual === null) return
    if (isDir) {
      if (old === undefined) {
        tree.put(source.id, entryOf(virtual, source))
        for await (const [boxId, entry] of walk(this.accessor.tokenManager, source.id, virtual)) {
          tree.put(boxId, entry)
        }
      }
      return
    }
    tree.put(source.id, entryOf(virtual, source))
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const decoded = decode(checkpoint)
    const observed = new Date()
    if (
      !decoded.native ||
      decoded.position === null ||
      decoded.pulled === null ||
      observed.getTime() - decoded.pulled.getTime() > EVENT_REPLAY_DAYS * DAY_MS
    ) {
      return this.relist(root, decoded.snapshot, observed)
    }
    const found = await eventsSince(this.accessor.tokenManager, decoded.position, EVENT_STREAM)
    const previous = decoded.snapshot ?? {}
    const tree = new Tree(previous, decoded.ids)
    const seen = new Set<string>()
    for (const event of found.entries) {
      // Box may send an event more than once; the id says so.
      const eventId = event.event_id
      if (eventId !== undefined && eventId !== '') {
        if (seen.has(eventId)) continue
        seen.add(eventId)
      }
      await this.apply(root, tree, event)
    }
    return new Delta({
      changes: diff(root, previous, tree, observed),
      checkpoint: encode(found.position, observed, tree),
    })
  }
}

/**
 * Map one Box user event onto mount paths.
 *
 * The consumer owns the long poll: `realtimeServer` gives the URL, a
 * `new_change` answer means read `eventsSince` from the last position, and
 * each event read goes through `toEvents` with its `event_type`. Nothing here
 * runs a loop.
 *
 * An event names the item's new place only. A trash or a move needs the old
 * one, so the hook remembers where each Box id it has mapped was. An id it has
 * never seen gets the honest answer instead: a move or rename of an unknown
 * item is UNKNOWN on the directory it landed in, and a trash of one is
 * dropped, since nothing this hook mapped is stale. The pull (`BoxDeltaHook`)
 * is the truth path for both.
 *
 * Upload of a new version and of a new file are the same `ITEM_UPLOAD`, so the
 * split between CREATE and UPDATE is also whether the id was seen before.
 */
export class BoxEventHook {
  private readonly accessor: BoxAccessor
  private readonly paths = new Map<string, string>()

  constructor(accessor: BoxAccessor) {
    this.accessor = accessor
  }

  toEvents(root: PathSpec, eventType: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    return Promise.resolve(this.map(root, eventType, payload))
  }

  private map(root: PathSpec, eventType: string, payload: JsonValue): readonly FileEvent[] {
    const source = sourceOf(payload)
    if (source === null) return []
    const old = this.paths.get(source.id)
    if (TRASH_EVENTS.has(eventType)) {
      this.paths.delete(source.id)
      return old === undefined ? [] : [eventAt(root, old, FileChangeKind.DELETE)]
    }
    if (!PLACE_EVENTS.has(eventType)) return []
    const relative = mountRelativeKey(source, this.accessor.rootFolderId)
    if (relative === null) {
      this.paths.delete(source.id)
      return old === undefined ? [] : [eventAt(root, old, FileChangeKind.DELETE)]
    }
    this.paths.set(source.id, relative)
    if (old !== undefined && old !== relative) {
      return [eventAt(root, relative, FileChangeKind.MOVE, old)]
    }
    if (old === undefined && (eventType === 'ITEM_MOVE' || eventType === 'ITEM_RENAME')) {
      const cut = relative.lastIndexOf('/')
      return [eventAt(root, cut === -1 ? '' : relative.slice(0, cut), FileChangeKind.UNKNOWN)]
    }
    if (old !== undefined || eventType === 'ITEM_MAKE_CURRENT_VERSION') {
      return [eventAt(root, relative, FileChangeKind.UPDATE)]
    }
    return [eventAt(root, relative, FileChangeKind.CREATE)]
  }
}

export function buildDeltaHook(accessor: BoxAccessor): DeltaHook {
  return new BoxDeltaHook(accessor)
}
