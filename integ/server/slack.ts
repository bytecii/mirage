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

// One shared fake Slack Web API, backed by Prisma + SQLite and seeded from
// integ/fixtures/slack/v1.json. The Python and TypeScript battery hosts both
// point their slack mounts at SLACK_URL/api and call it over HTTP, so every
// response is byte-identical across hosts by construction. Search endpoints
// (search.messages / search.files) are mocked so the grep/rg push-down runs
// live; they require a user token (xoxp-) exactly like real Slack.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(HERE, '..', 'prisma', 'schema.prisma')
const FIXTURE = join(HERE, '..', 'fixtures', 'slack', 'v1.json')
const DEFAULT_PORT = 5097

interface FixtureUser {
  id: string
  name: string
  real_name: string
  email: string
  is_bot?: boolean
  deleted?: boolean
}
interface FixtureChannel {
  id: string
  name: string
  kind: string
  created: number
}
interface FixtureDm {
  id: string
  user: string
  kind: string
  created: number
}
interface FixtureMessage {
  channel: string
  ts: string
  user: string
  text: string
}
interface FixtureFile {
  id: string
  channel: string
  message_ts: string
  name: string
  title: string
  mimetype: string
  filetype: string
  content: string
}
interface Fixture {
  users: FixtureUser[]
  channels: FixtureChannel[]
  dms: FixtureDm[]
  messages: FixtureMessage[]
  files: FixtureFile[]
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
}

// db push materializes schema.prisma into a fresh SQLite file per server
// instance, so every start is clean state (no migration history to carry).
function pushSchema(dbUrl: string): void {
  const prismaBin = createRequire(import.meta.url).resolve('prisma/build/index.js')
  execFileSync('node', [prismaBin, 'db', 'push', '--schema', SCHEMA, '--skip-generate'], {
    env: { ...process.env, SLACK_DB_URL: dbUrl },
    stdio: 'ignore',
  })
}

async function seed(db: PrismaClient, fx: Fixture): Promise<void> {
  await db.slackFile.deleteMany({})
  await db.message.deleteMany({})
  await db.channel.deleteMany({})
  await db.user.deleteMany({})
  for (const u of fx.users) {
    await db.user.create({
      data: {
        id: u.id,
        name: u.name,
        realName: u.real_name,
        email: u.email,
        isBot: u.is_bot ?? false,
        deleted: u.deleted ?? false,
      },
    })
  }
  for (const c of fx.channels) {
    await db.channel.create({
      data: { id: c.id, name: c.name, kind: c.kind, created: c.created },
    })
  }
  for (const d of fx.dms) {
    await db.channel.create({
      data: { id: d.id, name: '', kind: d.kind, created: d.created, dmUserId: d.user },
    })
  }
  for (const m of fx.messages) {
    await db.message.create({
      data: { channelId: m.channel, ts: m.ts, userId: m.user, text: m.text },
    })
  }
  for (const f of fx.files) {
    await db.slackFile.create({
      data: {
        id: f.id,
        channelId: f.channel,
        messageTs: f.message_ts,
        name: f.name,
        title: f.title,
        mimetype: f.mimetype,
        filetype: f.filetype,
        size: Buffer.byteLength(f.content, 'utf8'),
        timestamp: Math.floor(Number(f.message_ts)),
        content: f.content,
      },
    })
  }
}

interface ChannelRow {
  id: string
  name: string
  kind: string
  created: number
  isArchived: boolean
  isPrivate: boolean
  dmUserId: string | null
}
interface UserRow {
  id: string
  name: string
  realName: string
  email: string
  isBot: boolean
  deleted: boolean
}
interface FileRow {
  id: string
  channelId: string
  messageTs: string
  name: string
  title: string
  mimetype: string
  filetype: string
  size: number
  timestamp: number
  content: string
}

function userJson(u: UserRow): Record<string, unknown> {
  return {
    id: u.id,
    name: u.name,
    real_name: u.realName,
    is_bot: u.isBot,
    deleted: u.deleted,
    profile: { real_name: u.realName, display_name: u.name, email: u.email },
  }
}

function channelJson(c: ChannelRow): Record<string, unknown> {
  if (c.kind === 'im' || c.kind === 'mpim') {
    return { id: c.id, created: c.created, is_im: c.kind === 'im', user: c.dmUserId }
  }
  return {
    id: c.id,
    name: c.name,
    created: c.created,
    is_channel: true,
    is_private: c.isPrivate,
    is_archived: c.isArchived,
  }
}

function fileMeta(f: FileRow, host: string): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    filetype: f.filetype,
    size: f.size,
    timestamp: f.timestamp,
    url_private_download: `http://${host}/files/download/${f.id}`,
  }
}

// Slack search operators: `in:#channel` / `in:@user` scope the search; the
// rest of the query is the literal. Mirrors what core/slack build_query emits.
function parseQuery(query: string): { literal: string; channelName?: string; dmName?: string } {
  const terms: string[] = []
  let channelName: string | undefined
  let dmName: string | undefined
  for (const tok of query.split(/\s+/).filter((t) => t !== '')) {
    if (tok.startsWith('in:#')) channelName = tok.slice(4)
    else if (tok.startsWith('in:@')) dmName = tok.slice(4)
    else terms.push(tok)
  }
  return { literal: terms.join(' '), channelName, dmName }
}

function bearer(req: http.IncomingMessage): string {
  const auth = req.headers.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

type Reply = { status: number; json?: unknown; buffer?: Buffer; contentType?: string }

async function handle(
  db: PrismaClient,
  req: http.IncomingMessage,
  url: URL,
  host: string,
): Promise<Reply> {
  const path = url.pathname
  const q = url.searchParams

  if (req.method === 'POST' && path === '/reset') {
    await seed(db, loadFixture())
    return { status: 200, json: { ok: true } }
  }

  if (path.startsWith('/files/download/')) {
    const id = path.slice('/files/download/'.length)
    const file = (await db.slackFile.findUnique({ where: { id } })) as FileRow | null
    if (file === null) return { status: 404, json: { error: 'not_found' } }
    return { status: 200, buffer: Buffer.from(file.content, 'utf8'), contentType: file.mimetype }
  }

  if (path === '/api/conversations.list') {
    const types = (q.get('types') ?? '').split(',').filter((t) => t !== '')
    const kinds = types.map((t) => (t === 'public_channel' || t === 'private_channel' ? 'channel' : t))
    const where: Record<string, unknown> = { kind: { in: kinds.length > 0 ? kinds : ['channel'] } }
    if (q.get('exclude_archived') === 'true') where.isArchived = false
    const rows = (await db.channel.findMany({ where, orderBy: { id: 'asc' } })) as ChannelRow[]
    return {
      status: 200,
      json: { ok: true, channels: rows.map(channelJson), response_metadata: { next_cursor: '' } },
    }
  }

  if (path === '/api/conversations.history') {
    const channel = q.get('channel') ?? ''
    const oldest = q.get('oldest')
    const latest = q.get('latest')
    const limit = q.get('limit') !== null ? Number.parseInt(q.get('limit') as string, 10) : 100
    const where: Record<string, unknown> = { channelId: channel }
    const ts: Record<string, string> = {}
    if (oldest !== null) ts.gte = oldest
    if (latest !== null) ts.lte = latest
    if (Object.keys(ts).length > 0) where.ts = ts
    // Slack returns most-recent-first; the backend re-sorts the day window.
    const rows = (await db.message.findMany({
      where,
      orderBy: { ts: 'desc' },
      take: limit,
    })) as { channelId: string; ts: string; userId: string; text: string; type: string }[]
    const files = (await db.slackFile.findMany({ where: { channelId: channel } })) as FileRow[]
    const messages = rows.map((m) => {
      const attached = files.filter((f) => f.messageTs === m.ts)
      const base: Record<string, unknown> = { type: m.type, user: m.userId, text: m.text, ts: m.ts }
      if (attached.length > 0) base.files = attached.map((f) => fileMeta(f, host))
      return base
    })
    return { status: 200, json: { ok: true, messages, response_metadata: { next_cursor: '' } } }
  }

  if (path === '/api/users.list') {
    const rows = (await db.user.findMany({ orderBy: { id: 'asc' } })) as UserRow[]
    return {
      status: 200,
      json: { ok: true, members: rows.map(userJson), response_metadata: { next_cursor: '' } },
    }
  }

  if (path === '/api/users.info') {
    const user = (await db.user.findUnique({ where: { id: q.get('user') ?? '' } })) as UserRow | null
    if (user === null) return { status: 200, json: { ok: false, error: 'user_not_found' } }
    return { status: 200, json: { ok: true, user: userJson(user) } }
  }

  if (path === '/api/search.messages' || path === '/api/search.files') {
    // search.* requires a user token (xoxp-); a bot token is rejected exactly
    // like real Slack, so the backend falls back to the per-file scan.
    if (!bearer(req).startsWith('xoxp-')) {
      return { status: 200, json: { ok: false, error: 'not_allowed_token_type' } }
    }
    const parsed = parseQuery(q.get('query') ?? '')
    const channels = (await db.channel.findMany({})) as ChannelRow[]
    const users = (await db.user.findMany({})) as UserRow[]
    const userName = new Map(users.map((u) => [u.id, u.name]))
    const byId = new Map(channels.map((c) => [c.id, c]))
    const channelDisplay = (ch: ChannelRow): string =>
      ch.name !== '' ? ch.name : ch.dmUserId !== null ? (userName.get(ch.dmUserId) ?? ch.dmUserId) : ch.id
    let scopedChannelId: string | undefined
    if (parsed.channelName !== undefined) {
      scopedChannelId = channels.find((c) => c.name === parsed.channelName)?.id
    } else if (parsed.dmName !== undefined) {
      const dmUser = (await db.user.findFirst({ where: { name: parsed.dmName } })) as UserRow | null
      if (dmUser !== null) {
        scopedChannelId = channels.find((c) => c.dmUserId === dmUser.id)?.id
      }
    }
    const count = q.get('count') !== null ? Number.parseInt(q.get('count') as string, 10) : 20

    if (path === '/api/search.messages') {
      const where: Record<string, unknown> = { text: { contains: parsed.literal } }
      if (scopedChannelId !== undefined) where.channelId = scopedChannelId
      const rows = (await db.message.findMany({
        where,
        orderBy: { ts: 'asc' },
        take: count,
      })) as { channelId: string; ts: string; userId: string; text: string }[]
      const matches = rows.map((m) => {
        const ch = byId.get(m.channelId)
        const chName = ch !== undefined ? channelDisplay(ch) : ''
        return {
          type: 'message',
          user: m.userId,
          username: m.userId,
          ts: m.ts,
          text: m.text,
          channel: { id: m.channelId, name: chName },
        }
      })
      return {
        status: 200,
        json: {
          ok: true,
          query: q.get('query') ?? '',
          messages: {
            total: matches.length,
            pagination: { total_count: matches.length, page: 1, page_count: 1 },
            matches,
          },
        },
      }
    }

    const where: Record<string, unknown> = {
      OR: [
        { name: { contains: parsed.literal } },
        { title: { contains: parsed.literal } },
        { content: { contains: parsed.literal } },
      ],
    }
    if (scopedChannelId !== undefined) where.channelId = scopedChannelId
    const rows = (await db.slackFile.findMany({ where, orderBy: { id: 'asc' }, take: count })) as FileRow[]
    const matches = rows.map((f) => ({
      id: f.id,
      name: f.name,
      title: f.title,
      mimetype: f.mimetype,
      filetype: f.filetype,
      size: f.size,
      timestamp: f.timestamp,
    }))
    return {
      status: 200,
      json: {
        ok: true,
        query: q.get('query') ?? '',
        files: {
          total: matches.length,
          pagination: { total_count: matches.length, page: 1, page_count: 1 },
          matches,
        },
      },
    }
  }

  return { status: 404, json: { ok: false, error: 'unknown_method' } }
}

export async function startServer(port: number): Promise<http.Server> {
  const dbUrl = `file:${join(tmpdir(), `mirage-slack-${String(process.pid)}-${String(port)}.db`)}`
  process.env.SLACK_DB_URL = dbUrl
  pushSchema(dbUrl)
  const db = new PrismaClient()
  await seed(db, loadFixture())
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? `127.0.0.1:${String(port)}`
    const url = new URL(req.url ?? '/', `http://${host}`)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void handle(db, req, url, host)
        .then((reply) => {
          if (reply.buffer !== undefined) {
            res.writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'application/octet-stream' })
            res.end(reply.buffer)
            return
          }
          res.writeHead(reply.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(reply.json))
        })
        .catch((err: unknown) => {
          console.error('slack fake: route error', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
        })
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('slack.ts')
if (isMain) {
  const portArg = process.argv.indexOf('--port')
  const port = portArg !== -1 ? Number.parseInt(process.argv[portArg + 1] as string, 10) : DEFAULT_PORT
  void startServer(port).then(() => {
    console.log(`SLACK_URL=http://127.0.0.1:${String(port)}`)
  })
}
