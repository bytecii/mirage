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

import { createServer, type IncomingMessage, type Server } from 'node:http'

const MODIFIED = '2026-01-02T00:00:00Z'

interface DropboxEntryJson {
  '.tag': 'file' | 'folder'
  id: string
  name: string
  path_lower: string
  path_display: string
  size?: number
  server_modified?: string
}

// One fake Dropbox account: seeded files, folders implied by file paths.
// Serves the three endpoints the backend calls — /oauth2/token,
// /2/files/list_folder, /2/files/download — on a single origin, matching
// the DropboxConfig `endpoint` override.
export interface FakeDropbox {
  endpoint: string
  seed: (path: string, content: Uint8Array) => void
  close: () => void
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function folderSet(files: Map<string, Uint8Array>): Set<string> {
  const folders = new Set<string>()
  for (const path of files.keys()) {
    const parts = path.split('/').slice(1, -1)
    let cur = ''
    for (const part of parts) {
      cur += `/${part}`
      folders.add(cur)
    }
  }
  return folders
}

function listChildren(files: Map<string, Uint8Array>, path: string): DropboxEntryJson[] | null {
  const folders = folderSet(files)
  if (path !== '' && !folders.has(path)) return null
  const out: DropboxEntryJson[] = []
  for (const folder of folders) {
    if (folder.slice(0, folder.lastIndexOf('/')) !== path) continue
    out.push({
      '.tag': 'folder',
      id: `id:${folder}`,
      name: folder.slice(folder.lastIndexOf('/') + 1),
      path_lower: folder.toLowerCase(),
      path_display: folder,
    })
  }
  for (const [file, content] of files) {
    if (file.slice(0, file.lastIndexOf('/')) !== path) continue
    out.push({
      '.tag': 'file',
      id: `id:${file}`,
      name: file.slice(file.lastIndexOf('/') + 1),
      path_lower: file.toLowerCase(),
      path_display: file,
      size: content.length,
      server_modified: MODIFIED,
    })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

export function startFakeDropbox(): Promise<FakeDropbox> {
  const files = new Map<string, Uint8Array>()
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (url === '/oauth2/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'integ-token', expires_in: 14400 }))
        return
      }
      if (url === '/2/files/list_folder') {
        const body = JSON.parse(await readBody(req)) as { path?: string }
        const entries = listChildren(files, body.path ?? '')
        if (entries === null) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error_summary: 'path/not_found/...' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ entries, cursor: 'cursor-0', has_more: false }))
        return
      }
      if (url === '/2/files/download') {
        await readBody(req)
        const arg = JSON.parse(String(req.headers['dropbox-api-arg'] ?? '{}')) as {
          path?: string
        }
        const content = files.get(arg.path ?? '')
        if (content === undefined) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error_summary: 'path/not_found/...' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(Buffer.from(content))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error_summary: `unknown endpoint ${url}` }))
    })().catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('fake dropbox server has no port')
      }
      resolve({
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        seed: (path, content) => files.set(path, content),
        close: () => server.close(),
      })
    })
  })
}
