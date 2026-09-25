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

import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_PREFIXES } from './config.ts'
import type { C } from './config.ts'
import { blobSha } from './wire.ts'
import { allRepos, metaOf, repoByName, searchTree, treeOfBranch } from './store.ts'
import type { RepoRow } from './store.ts'
import { authedRoute, everywhere, fail, route } from './http.ts'
import { repoJson } from './repos.ts'

const TOKEN_RE = /[A-Za-z0-9_]+/g

// Content and metadata filters of the code-search grammar. The fake does not
// evaluate them, so they are dropped, which only ever widens; matched as words instead, they would demand the literal tokens
// `language` and `python` and answer almost nothing.
const WIDENING_QUALIFIERS = new Set(['language', 'extension', 'filename', 'in', 'size', 'fork'])

function starsOf(repo: RepoRow): number {
  const value = metaOf(repo).stargazers_count
  return typeof value === 'number' ? value : 0
}

function descriptionOf(repo: RepoRow): string {
  const value = metaOf(repo).description
  return typeof value === 'string' ? value : ''
}

interface RepoQuery {
  owners: string[]
  terms: string[]
}

// `user:` and `org:` are honoured, because they NARROW: GitHub answers
// `user:integ-user` with that account's repositories and nobody else's, and a
// caller handed every account's instead reads the surplus as fact. The rest of
// the grammar (`in:name`, `language:`, `fork:`) is still dropped, which only
// ever widens. What is left over is matched against the name and the
// description, because a repository is found by what it says it does at least
// as often as by what it is called. Terms OR together rather than AND, which is
// looser than GitHub and errs towards showing a caller the row it is looking
// for; a hyphenated term also matches its parts.
function repoQuery(query: string): RepoQuery {
  const owners: string[] = []
  const terms: string[] = []
  for (const word of query.split(/\s+/).filter((w) => w !== '')) {
    const at = word.indexOf(':')
    if (at >= 0) {
      const owner = word.slice(at + 1)
      // Several of them OR together, the way GitHub reads them.
      if ((word.slice(0, at) === 'user' || word.slice(0, at) === 'org') && owner !== '') {
        owners.push(owner)
      }
      continue
    }
    terms.push(word)
    for (const part of word.split(/[-_]/)) if (part.length > 2) terms.push(part)
  }
  return { owners, terms }
}

// Substring rather than GitHub's own qualifier grammar, which nothing here
// parses. It is here at all because the alternative is a 404, and a caller
// reads that as "no such repository": an agent looking for the fork it just
// made would conclude it had not made one.
async function searchRepos(ctx: Ctx<C>): Promise<Reply> {
  // Lowercased before it is split, so a login compares case-insensitively the
  // way GitHub's own do.
  const query = (ctx.query.get('q') ?? '').toLowerCase()
  const { owners, terms } = repoQuery(query)
  const repos = await allRepos(ctx.db, ctx.tenant)
  const matched = repos.filter((repo) => {
    if (owners.length > 0 && !owners.includes(repo.owner.toLowerCase())) return false
    const haystack = `${repo.fullName} ${descriptionOf(repo)}`.toLowerCase()
    return terms.length === 0 || terms.some((t) => haystack.includes(t))
  })
  // GitHub's default is relevance, which is not modelled; `sort=stars` is,
  // because a task that asks for "the most starred" is asking for exactly
  // this ordering.
  if (ctx.query.get('sort') === 'stars') {
    const sign = (ctx.query.get('order') ?? 'desc') === 'asc' ? 1 : -1
    matched.sort((a, b) => sign * (starsOf(a) - starsOf(b)))
  } else {
    matched.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0))
  }
  const items = matched.map(repoJson)
  return { status: 200, body: { total_count: items.length, incomplete_results: false, items } }
}

interface CodeQuery {
  repos: string[]
  owners: string[]
  terms: string[]
  pathFilter: string | null
}

// The scope qualifiers narrow, so they are honoured: several `repo:` OR
// together, `user:` and `org:` OR together, and the two groups AND, the way
// the live API reads them. A name is matched exactly and case-sensitively, as
// the live API does (`REPO:x` is a term there too), so `std::vector` and
// `-repo:x` fall through to the tokenizer. An empty value is dropped, as in
// `repoQuery`. `repo:` and `path:` values are kept as written, because both
// are compared exactly; owners and terms are lowercased.
function codeQuery(query: string): CodeQuery {
  const repos: string[] = []
  const owners: string[] = []
  const terms: string[] = []
  let pathFilter: string | null = null
  for (const word of query.split(/\s+/).filter((w) => w !== '')) {
    const at = word.indexOf(':')
    const name = at >= 0 ? word.slice(0, at) : ''
    const value = word.slice(at + 1)
    if (name === 'repo') {
      if (value !== '' && !repos.includes(value)) repos.push(value)
    } else if (name === 'user' || name === 'org') {
      if (value !== '') owners.push(value.toLowerCase())
    } else if (name === 'path') {
      pathFilter = value
    } else if (!WIDENING_QUALIFIERS.has(name)) {
      terms.push(...(word.toLowerCase().match(TOKEN_RE) ?? []))
    }
  }
  return { repos, owners, terms, pathFilter }
}

// Code search reads only the default branch, which is where the fake builds
// its term index. A query that names no scope is answered over every
// repository the tenant holds, because an authenticated caller of the live
// API is answered over all of GitHub rather than refused; here that is
// usually `total_count: 0`. A `repo:` group disjoint from the owner group
// answers empty where live refuses it with a query-parse 422. Live refuses an
// empty qualifier value the same way; here it is dropped, which widens. A
// query naming only repositories none of which exists keeps its 404, although
// live answers it 200 with nothing. An empty `q` is refused as live refuses
// it, without the `errors` array, which no caller reads.
async function searchCode(ctx: Ctx<C>): Promise<Reply> {
  const query = (ctx.query.get('q') ?? '').trim()
  if (query === '') return fail(422, 'Validation Failed')
  const { repos, owners, terms, pathFilter } = codeQuery(query)
  let scope: RepoRow[]
  if (repos.length > 0) {
    const named = await Promise.all(repos.map((name) => repoByName(ctx.db, ctx.tenant, name)))
    scope = named.filter((repo): repo is RepoRow => repo !== null)
    if (scope.length === 0) return fail(404, 'Not Found')
  } else {
    scope = await allRepos(ctx.db, ctx.tenant)
  }
  if (owners.length > 0) scope = scope.filter((repo) => owners.includes(repo.owner.toLowerCase()))
  // Full-name order rather than relevance, which is not modelled, so the
  // answer is the same on every run.
  scope.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0))
  const items: JsonValue[] = []
  for (const repo of scope) {
    const files = await treeOfBranch(ctx.db, ctx.tenant, repo, repo.defaultBranch)
    for (const path of searchTree(files, terms, pathFilter)) {
      const data = files.get(path)
      if (data === undefined) continue
      items.push({
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        sha: blobSha(data),
        score: 1.0,
        repository: { name: repo.name, full_name: repo.fullName },
      })
    }
  }
  return { status: 200, body: { total_count: items.length, incomplete_results: false, items } }
}

export function searchRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('GET', `${p}/search/code`, authedRoute(searchCode)),
    route<C>('GET', `${p}/search/repositories`, authedRoute(searchRepos)),
  ])
}
