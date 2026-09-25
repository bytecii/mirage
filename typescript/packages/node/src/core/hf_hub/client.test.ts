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

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HfHubError,
  apiUrl,
  errorOf,
  etagValue,
  hubBytesTagged,
  hubHeaders,
  hubPost,
  hubStream,
  resolveUrl,
  revSegment,
} from './client.ts'

describe('hubHeaders', () => {
  it('omits Authorization without a token', () => {
    expect(hubHeaders(undefined)).toEqual({ Accept: 'application/json' })
    expect(hubHeaders('')).toEqual({ Accept: 'application/json' })
  })

  it('carries a bearer token', () => {
    expect(hubHeaders('tok').Authorization).toBe('Bearer tok')
  })
})

describe('apiUrl', () => {
  it.each([
    ['model', 'https://huggingface.co/api/models/a/b/refs'],
    ['dataset', 'https://huggingface.co/api/datasets/a/b/refs'],
    ['space', 'https://huggingface.co/api/spaces/a/b/refs'],
  ])('pluralizes %s', (repoType, expected) => {
    expect(apiUrl('https://huggingface.co', repoType, 'a/b', '/refs')).toBe(expected)
  })
})

describe('resolveUrl', () => {
  it.each([
    ['model', 'https://huggingface.co/a/b/resolve/main/f.json'],
    ['dataset', 'https://huggingface.co/datasets/a/b/resolve/main/f.json'],
    ['space', 'https://huggingface.co/spaces/a/b/resolve/main/f.json'],
  ])('puts a %s at its own segment', (repoType, expected) => {
    // The content host is not the API host's table: a model's files hang off
    // the bare repo id while a dataset's and a space's sit under their own
    // segment, so reusing the API's plural here 404s every model read.
    expect(resolveUrl('https://huggingface.co', repoType, 'a/b', 'main', 'f.json')).toBe(expected)
  })

  it('percent-encodes each path segment', () => {
    const url = resolveUrl('https://huggingface.co', 'model', 'a/b', 'main', 'dir/a file#1.txt')
    expect(url.endsWith('/resolve/main/dir/a%20file%231.txt')).toBe(true)
  })

  it('keeps slashes between segments', () => {
    const url = resolveUrl('https://huggingface.co', 'model', 'a/b', 'main', 'deep/nested/f.txt')
    expect(url.endsWith('/resolve/main/deep/nested/f.txt')).toBe(true)
  })
})

describe('errorOf', () => {
  it('prefers the Hub error header', () => {
    const response = new Response('{"error":"whatever"}', {
      status: 404,
      headers: { 'X-Error-Message': 'Entry not found' },
    })
    const err = errorOf(response, '{"error":"whatever"}')
    expect(err).toBeInstanceOf(HfHubError)
    expect(err.message).toBe('Entry not found')
    expect((err as HfHubError).status).toBe(404)
  })

  it('falls back to the body', () => {
    const err = errorOf(new Response('boom', { status: 500 }), '  boom  ')
    expect(err.message).toBe('boom')
    expect((err as HfHubError).status).toBe(500)
  })
})

describe('revSegment', () => {
  it('encodes a slash', () => {
    // A git ref may hold one, and every Hub route reads the segment after
    // the verb as the whole revision, so an unencoded one splits.
    expect(revSegment('feature/foo')).toBe('feature%2Ffoo')
    expect(revSegment('refs/pr/1')).toBe('refs%2Fpr%2F1')
  })

  it('leaves an ordinary ref alone', () => {
    expect(revSegment('main')).toBe('main')
    expect(revSegment('v1.0.0-rc.1')).toBe('v1.0.0-rc.1')
  })

  it("encodes the four characters encodeURIComponent does not, as python's quote does", () => {
    expect(revSegment("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af')
  })
})

describe('errorOf error code', () => {
  it('reads the X-Error-Code header', () => {
    // walkPages folds a missing subtree by this code alone, so it has to
    // survive from the header onto the error.
    const response = new Response('', { status: 404, headers: { 'X-Error-Code': 'EntryNotFound' } })
    expect((errorOf(response, '') as HfHubError).errorCode).toBe('EntryNotFound')
  })

  it('is empty without the header', () => {
    expect((errorOf(new Response('', { status: 401 }), '') as HfHubError).errorCode).toBe('')
  })
})

describe('etagValue', () => {
  it.each([
    ['"abc"', 'abc'],
    ['W/"abc"', 'abc'],
    ['abc', 'abc'],
    ['', ''],
  ])('strips the weak prefix and quotes from %s', (raw, expected) => {
    expect(etagValue(raw)).toBe(expected)
  })
})

describe('the download wire', () => {
  const seen: { range?: string; contentType?: string }[] = []
  let body = new TextEncoder().encode('0123456789')
  let ignoreRange = false
  let server: Server
  let base = ''

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/resolve') {
      // The first hop's ETag differs from the bytes', as the live Hub's does
      // (x-linked-etag names the LFS sha); only the final one is the token.
      res.writeHead(302, { Location: '/cdn', ETag: '"first-hop"' })
      res.end()
      return
    }
    if (req.url === '/post') {
      seen.push({ contentType: req.headers['content-type'] ?? '' })
      req.resume()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('[]')
      return
    }
    const range = req.headers.range ?? ''
    seen.push({ range })
    if (range !== '' && !ignoreRange) {
      const [first, last] = range.slice('bytes='.length).split('-')
      res.writeHead(206, { ETag: '"final-hop"' })
      res.end(Buffer.from(body.slice(Number(first), Number(last) + 1)))
      return
    }
    res.writeHead(200, { ETag: '"final-hop"' })
    res.end(Buffer.from(body))
  }

  beforeEach(async () => {
    seen.length = 0
    body = new TextEncoder().encode('0123456789')
    ignoreRange = false
    server = createServer(handle)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) =>
      server.close(() => {
        done()
      }),
    )
  })

  it("hubBytesTagged returns the final hop's etag", async () => {
    const [data, etag] = await hubBytesTagged(undefined, `${base}/resolve`)
    expect(new TextDecoder().decode(data)).toBe('0123456789')
    expect(etag).toBe('"final-hop"')
  })

  it('hubBytesTagged sends the window', async () => {
    const [data] = await hubBytesTagged(undefined, `${base}/resolve`, { offset: 2, size: 3 })
    expect(new TextDecoder().decode(data)).toBe('234')
    expect(seen.at(-1)?.range).toBe('bytes=2-4')
  })

  it('hubBytesTagged trims an ignored range', async () => {
    ignoreRange = true
    const [data] = await hubBytesTagged(undefined, `${base}/resolve`, { offset: 2, size: 3 })
    expect(new TextDecoder().decode(data)).toBe('234')
  })

  it('hubStream reports the final headers before the first chunk', async () => {
    const order: string[] = []
    const headers: Record<string, string>[] = []
    for await (const chunk of hubStream(undefined, `${base}/resolve`, (h) => {
      order.push('headers')
      headers.push(h)
    }))
      order.push(new TextDecoder().decode(chunk))
    expect(order[0]).toBe('headers')
    expect(order.slice(1).join('')).toBe('0123456789')
    // Keys are lower-cased, so a reader's lookup of "etag" finds the server's
    // "ETag" whatever case it was sent in.
    expect(headers).toHaveLength(1)
    expect(headers[0]?.etag).toBe('"final-hop"')
  })

  it('hubStream reports headers for an empty file', async () => {
    body = new Uint8Array()
    let calls = 0
    const chunks: Uint8Array[] = []
    for await (const chunk of hubStream(undefined, `${base}/resolve`, () => {
      calls += 1
    }))
      chunks.push(chunk)
    // An empty file yields no chunk, so a callback fired lazily on the first
    // one would never stamp it.
    expect(chunks).toEqual([])
    expect(calls).toBe(1)
  })

  it('hubPost sends a JSON content type', async () => {
    // The live Hub answers a paths-info body without it with 400.
    await hubPost(undefined, `${base}/post`, { paths: ['a.txt'] })
    expect(seen.at(-1)?.contentType).toBe('application/json')
  })
})
