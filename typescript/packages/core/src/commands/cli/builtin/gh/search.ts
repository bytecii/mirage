import { compareCodePoints } from '../../../../utils/sort.ts'
import type { JsonValue } from '../../../../types.ts'
import { csvValues, ghTransport, jsonFields, typedOut, textOut } from './accessor.ts'
import { renderTemplate } from './template.ts'
import { CLISpec, type CLIInvocation } from '../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { UsageError } from '../../../errors.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { Option, Operand } from '../../../spec/types.ts'
import { search } from '../../../../core/github/search.ts'

const FLAGS: Record<string, string[]> = {
  issues: [
    'app',
    'archived',
    'assignee',
    'author',
    'closed',
    'commenter',
    'comments',
    'created',
    'interactions',
    'involves',
    'label',
    'language',
    'locked',
    'match',
    'mentions',
    'milestone',
    'no-assignee',
    'no-label',
    'no-milestone',
    'no-project',
    'owner',
    'project',
    'reactions',
    'repo',
    'state',
    'team-mentions',
    'updated',
    'visibility',
    'include-prs',
  ],
  prs: [
    'app',
    'archived',
    'assignee',
    'author',
    'closed',
    'commenter',
    'comments',
    'created',
    'interactions',
    'involves',
    'label',
    'language',
    'locked',
    'match',
    'mentions',
    'milestone',
    'no-assignee',
    'no-label',
    'no-milestone',
    'no-project',
    'owner',
    'project',
    'reactions',
    'repo',
    'state',
    'team-mentions',
    'updated',
    'visibility',
    'base',
    'checks',
    'draft',
    'head',
    'merged',
    'merged-at',
    'review',
    'review-requested',
    'reviewed-by',
  ],
  repos: [
    'archived',
    'created',
    'followers',
    'forks',
    'good-first-issues',
    'help-wanted-issues',
    'include-forks',
    'language',
    'license',
    'match',
    'number-topics',
    'owner',
    'size',
    'stars',
    'topic',
    'updated',
    'visibility',
  ],
  code: ['extension', 'filename', 'language', 'match', 'owner', 'repo', 'size'],
  commits: [
    'author',
    'author-date',
    'author-email',
    'author-name',
    'committer',
    'committer-date',
    'committer-email',
    'committer-name',
    'hash',
    'merge',
    'owner',
    'parent',
    'repo',
    'tree',
    'visibility',
  ],
}
const MULTIPLE: string[] = ['label', 'match', 'owner', 'repo', 'visibility', 'license', 'topic']
const BOOLEAN: string[] = [
  'archived',
  'draft',
  'merge',
  'locked',
  'merged',
  'include-prs',
  'no-assignee',
  'no-label',
  'no-milestone',
  'no-project',
]
const ALIASES: Record<string, string> = {
  owner: 'user',
  match: 'in',
  visibility: 'is',
  'team-mentions': 'team',
  checks: 'status',
  'merged-at': 'merged',
  'number-topics': 'topics',
  'include-forks': 'fork',
}
const SORTS: Record<string, string[]> = {
  issues: [
    'comments',
    'created',
    'interactions',
    'reactions',
    'reactions-+1',
    'reactions--1',
    'reactions-heart',
    'reactions-smile',
    'reactions-tada',
    'reactions-thinking_face',
    'updated',
  ],
  prs: [
    'comments',
    'created',
    'interactions',
    'reactions',
    'reactions-+1',
    'reactions--1',
    'reactions-heart',
    'reactions-smile',
    'reactions-tada',
    'reactions-thinking_face',
    'updated',
  ],
  repos: ['forks', 'help-wanted-issues', 'stars', 'updated'],
  commits: ['author-date', 'committer-date'],
}
const FIELDS: Record<string, string[]> = {
  issues: [
    'assignees',
    'author',
    'authorAssociation',
    'body',
    'closedAt',
    'commentsCount',
    'createdAt',
    'id',
    'isLocked',
    'isPullRequest',
    'labels',
    'number',
    'repository',
    'state',
    'title',
    'updatedAt',
    'url',
  ],
  prs: [
    'assignees',
    'author',
    'authorAssociation',
    'body',
    'closedAt',
    'commentsCount',
    'createdAt',
    'id',
    'isLocked',
    'isPullRequest',
    'labels',
    'number',
    'repository',
    'state',
    'title',
    'updatedAt',
    'url',
    'isDraft',
  ],
  repos: [
    'createdAt',
    'defaultBranch',
    'description',
    'forksCount',
    'fullName',
    'hasDownloads',
    'hasIssues',
    'hasPages',
    'hasProjects',
    'hasWiki',
    'homepage',
    'id',
    'isArchived',
    'isDisabled',
    'isFork',
    'isPrivate',
    'language',
    'license',
    'name',
    'openIssuesCount',
    'owner',
    'pushedAt',
    'size',
    'stargazersCount',
    'updatedAt',
    'url',
    'visibility',
    'watchersCount',
  ],
  code: ['path', 'repository', 'sha', 'textMatches', 'url'],
  commits: ['author', 'commit', 'committer', 'sha', 'id', 'parents', 'repository', 'url'],
}

function quote(value: string): string {
  return /[\s"]/.test(value) ? JSON.stringify(value) : value
}
function boolean(fl: FlagView, name: string): boolean {
  name = name.replaceAll('-', '_')
  return fl.asBool(name) || fl.asStr(name.replaceAll('-', '_')) === 'true'
}

function query(kind: string, words: readonly string[], fl: FlagView): string {
  const qualifiers: Partial<Record<string, string[]>> = {}
  for (const name of FLAGS[kind] ?? []) {
    const value = fl.raw(name.replaceAll('-', '_'))
    if (
      value === undefined ||
      ['app', 'include-prs', 'locked', 'merged'].includes(name) ||
      name.startsWith('no-')
    )
      continue
    let key = ALIASES[name] ?? name
    if (name === 'review-requested' && typeof value === 'string' && value.includes('/'))
      key = 'team-review-requested'
    const values = BOOLEAN.includes(name)
      ? [String(boolean(fl, name))]
      : MULTIPLE.includes(name)
        ? csvValues(fl.asList(name.replaceAll('-', '_')))
        : [fl.asStr(name.replaceAll('-', '_')) ?? '']
    ;(qualifiers[key] ??= []).push(...values.filter(Boolean))
  }
  if (kind === 'issues' || kind === 'prs') {
    if (kind === 'prs' || !boolean(fl, 'include_prs'))
      qualifiers.type = [kind === 'prs' ? 'pr' : 'issue']
    if (fl.asStr('app') !== undefined) {
      if (fl.asStr('author') !== undefined)
        throw new UsageError('specify only `--author` or `--app`', 1)
      qualifiers.author = [`app/${fl.asStr('app') ?? ''}`]
    }
    for (const name of kind === 'prs' ? ['locked', 'merged'] : ['locked']) {
      if (fl.raw(name) !== undefined)
        (qualifiers.is ??= []).push(boolean(fl, name) ? name : `un${name}`)
    }
    qualifiers.no = ['assignee', 'label', 'milestone', 'project'].filter((name) =>
      boolean(fl, `no_${name}`),
    )
  }
  const keywords = words.map((word) => {
    const at = word.indexOf(':')
    return at < 0 ? quote(word) : `${word.slice(0, at)}:${quote(word.slice(at + 1))}`
  })
  return [
    ...keywords,
    ...Object.keys(qualifiers)
      .flatMap((key) => (qualifiers[key] ?? []).map((value) => `${key}:${quote(value)}`))
      .sort(compareCodePoints),
  ].join(' ')
}

function option(name: string): Option {
  const choices: Record<string, string[]> = {
    state: ['open', 'closed'],
    'include-forks': ['false', 'true', 'only'],
    checks: ['pending', 'success', 'failure'],
    review: ['none', 'required', 'approved', 'changes_requested'],
  }
  const shorts: Record<string, string> = { repo: '-R', base: '-B', head: '-H' }
  return new Option({
    long: `--${name}`,
    ...(shorts[name] === undefined ? {} : { short: shorts[name] }),
    type: 'str',
    multiple: MULTIPLE.includes(name),
    valueOptional: BOOLEAN.includes(name),
    choices: BOOLEAN.includes(name) ? ['true', 'false'] : (choices[name] ?? []),
  })
}

export function searchSpec(): CLISpec {
  return new CLISpec({
    name: 'search',
    description: 'Search GitHub',
    subcommands: Object.entries(FLAGS).map(
      ([kind, names]) =>
        new CLISpec({
          name: kind,
          description: `Search for ${kind}`,
          fn: (inv) => searchCmd(kind, inv),
          rest: new Operand({ type: 'str', name: 'QUERY' }),
          options: [
            ...names.map(option),
            new Option({ long: '--json', type: 'str' }),
            new Option({ long: '--jq', short: '-q', type: 'str' }),
            new Option({ long: '--template', short: '-t', type: 'str' }),
            new Option({ long: '--limit', short: '-L', type: 'int', default: '30' }),
            ...(SORTS[kind] === undefined
              ? []
              : [
                  new Option({ long: '--sort', type: 'str', choices: SORTS[kind] }),
                  new Option({ long: '--order', type: 'str', choices: ['asc', 'desc'] }),
                ]),
          ],
        }),
    ),
  })
}

async function searchCmd(kind: string, inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags, inv.spec)
  const fields = jsonFields(fl, FIELDS[kind] ?? [])
  const limit = fl.asInt('limit')
  if (limit === undefined || limit < 1 || limit > 1000)
    throw new UsageError('`--limit` must be between 1 and 1000', 1)
  if (inv.texts.length === 0 && inv.argv.length <= 2)
    throw new UsageError('specify search keywords or flags', 1)
  if (fields === null && (fl.asStr('jq') !== undefined || fl.asStr('template') !== undefined))
    throw new UsageError('cannot use `--jq` or `--template` without `--json`', 1)
  if (fl.asStr('jq') !== undefined && fl.asStr('template') !== undefined)
    throw new UsageError('cannot use `--jq` and `--template` together', 1)
  const values = await search(
    ghTransport(inv.config),
    ({ repos: 'repositories', prs: 'issues' } as Record<string, string>)[kind] ?? kind,
    query(kind, inv.texts, fl),
    limit,
    SORTS[kind] ? fl.asStr('sort') : undefined,
    SORTS[kind] ? fl.asStr('order') : undefined,
  )
  const rows = values.map((value) => exported(kind, value))
  const template = fl.asStr('template')
  if (template !== undefined)
    return textOut(
      renderTemplate(
        template,
        rows.map((row) => Object.fromEntries((fields ?? []).map((key) => [key, row[key] ?? null]))),
      ),
    )
  return typedOut(
    rows,
    fl,
    human(kind, rows, values, kind === 'issues' && boolean(fl, 'include_prs')),
    FIELDS[kind] ?? [],
  )
}

const SHAPES: Record<string, [string, string, string][]> = {
  Repository: [
    ['createdAt', 'created_at', 'time.Time'],
    ['defaultBranch', 'default_branch', 'string'],
    ['description', 'description', 'string'],
    ['forksCount', 'forks_count', 'int'],
    ['fullName', 'full_name', 'string'],
    ['hasDownloads', 'has_downloads', 'bool'],
    ['hasIssues', 'has_issues', 'bool'],
    ['hasPages', 'has_pages', 'bool'],
    ['hasProjects', 'has_projects', 'bool'],
    ['hasWiki', 'has_wiki', 'bool'],
    ['homepage', 'homepage', 'string'],
    ['id', 'node_id', 'string'],
    ['isArchived', 'archived', 'bool'],
    ['isDisabled', 'disabled', 'bool'],
    ['isFork', 'fork', 'bool'],
    ['isPrivate', 'private', 'bool'],
    ['language', 'language', 'string'],
    ['license', 'license', 'License'],
    ['masterBranch', 'master_branch', 'string'],
    ['name', 'name', 'string'],
    ['openIssuesCount', 'open_issues_count', 'int'],
    ['owner', 'owner', 'User'],
    ['pushedAt', 'pushed_at', 'time.Time'],
    ['size', 'size', 'int'],
    ['stargazersCount', 'stargazers_count', 'int'],
    ['url', 'html_url', 'string'],
    ['updatedAt', 'updated_at', 'time.Time'],
    ['visibility', 'visibility', 'string'],
    ['watchersCount', 'watchers_count', 'int'],
  ],
  User: [
    ['gravatarID', 'gravatar_id', 'string'],
    ['id', 'node_id', 'string'],
    ['login', 'login', 'string'],
    ['siteAdmin', 'site_admin', 'bool'],
    ['type', 'type', 'string'],
    ['url', 'html_url', 'string'],
  ],
  CommitInfo: [
    ['author', 'author', 'CommitUser'],
    ['commentCount', 'comment_count', 'int'],
    ['committer', 'committer', 'CommitUser'],
    ['message', 'message', 'string'],
    ['tree', 'tree', 'Tree'],
  ],
  CommitUser: [
    ['date', 'date', 'time.Time'],
    ['email', 'email', 'string'],
    ['name', 'name', 'string'],
  ],
  Tree: [['sha', 'sha', 'string']],
  Parent: [
    ['sha', 'sha', 'string'],
    ['url', 'html_url', 'string'],
  ],
  License: [
    ['key', 'key', 'string'],
    ['name', 'name', 'string'],
    ['url', 'url', 'string'],
  ],
  Label: [
    ['color', 'color', 'string'],
    ['description', 'description', 'string'],
    ['id', 'node_id', 'string'],
    ['name', 'name', 'string'],
  ],
  Issue: [
    ['assignees', 'assignees', '[]User'],
    ['author', 'user', 'User'],
    ['authorAssociation', 'author_association', 'string'],
    ['body', 'body', 'string'],
    ['closedAt', 'closed_at', 'time.Time'],
    ['commentsCount', 'comments', 'int'],
    ['createdAt', 'created_at', 'time.Time'],
    ['id', 'node_id', 'string'],
    ['labels', 'labels', '[]Label'],
    ['isDraft', 'draft', '*bool'],
    ['isLocked', 'locked', 'bool'],
    ['number', 'number', 'int'],
    ['pullRequest', 'pull_request', 'PullRequest'],
    ['repositoryURL', 'repository_url', 'string'],
    ['stateInternal', 'state', 'string'],
    ['stateReason', 'state_reason', 'string'],
    ['title', 'title', 'string'],
    ['url', 'html_url', 'string'],
    ['updatedAt', 'updated_at', 'time.Time'],
  ],
  Code: [
    ['name', 'name', 'string'],
    ['path', 'path', 'string'],
    ['repository', 'repository', 'Repository'],
    ['sha', 'sha', 'string'],
    ['textMatches', 'text_matches', '[]TextMatch'],
    ['url', 'html_url', 'string'],
  ],
  Commit: [
    ['author', 'author', 'User'],
    ['committer', 'committer', 'User'],
    ['id', 'node_id', 'string'],
    ['info', 'commit', 'CommitInfo'],
    ['parents', 'parents', '[]Parent'],
    ['repo', 'repository', 'Repository'],
    ['sha', 'sha', 'string'],
    ['url', 'html_url', 'string'],
  ],
}

type Row = Record<string, JsonValue>
function record(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {}
}
function shape(kind: string, value: JsonValue | undefined): JsonValue {
  if (kind.startsWith('*')) return value == null ? null : shape(kind.slice(1), value)
  if (kind.startsWith('[]'))
    return Array.isArray(value) ? value.map((item) => shape(kind.slice(2), item)) : null
  if (kind === 'time.Time') return value ?? '0001-01-01T00:00:00Z'
  if (kind === 'string') return value ?? ''
  if (kind === 'bool') return Boolean(value)
  if (kind === 'int') return value ?? 0
  const row = record(value)
  return Object.fromEntries(
    (SHAPES[kind] ?? []).map(([name, key, type]) => [name, shape(type, row[key])]),
  )
}
function user(value: unknown): Row {
  const row = record(value),
    bot = !row.node_id
  return {
    id: row.node_id ?? '',
    login: `${bot ? 'app/' : ''}${str(row.login)}`,
    type: row.type ?? '',
    url: row.html_url ?? '',
    is_bot: bot,
  }
}
function exported(kind: string, value: unknown): Row {
  const raw = record(value)
  const row = shape(
    (
      {
        repos: 'Repository',
        issues: 'Issue',
        prs: 'Issue',
        code: 'Code',
        commits: 'Commit',
      } as Record<string, string>
    )[kind] ?? '',
    raw,
  ) as Row
  if (kind === 'repos') row.owner = user(raw.owner)
  else if (kind === 'issues' || kind === 'prs') {
    row.author = user(raw.user)
    row.assignees = ((raw.assignees ?? []) as unknown[]).map(user)
    row.labels ??= []
    const pull = record(raw.pull_request)
    row.isPullRequest = Boolean(pull.html_url)
    row.state = pull.merged_at ? 'merged' : (raw.state ?? '')
    const parts = str(raw.repository_url).replace(/\/$/, '').split('/')
    row.repository = { name: parts.at(-1) ?? '', nameWithOwner: parts.slice(-2).join('/') }
  } else if (kind === 'code') {
    const repo = record(raw.repository)
    row.repository = {
      id: repo.node_id ?? '',
      nameWithOwner: repo.full_name ?? '',
      url: repo.html_url ?? '',
      isPrivate: Boolean(repo.private),
      isFork: Boolean(repo.fork),
    }
    row.textMatches = ((raw.text_matches ?? []) as Row[]).map((m) => ({
      fragment: m.fragment ?? '',
      matches: m.matches ?? null,
      type: m.object_type ?? '',
      property: m.property ?? '',
    }))
  } else if (kind === 'commits') {
    row.author = user(raw.author)
    row.committer = user(raw.committer)
    const info = record(raw.commit)
    row.commit = {
      author: shape('CommitUser', info.author),
      committer: shape('CommitUser', info.committer),
      comment_count: info.comment_count ?? 0,
      message: info.message ?? '',
      tree: shape('Tree', info.tree),
    }
    row.parents ??= []
    const repo = exported('repos', raw.repository)
    row.repository = Object.fromEntries(
      ['description', 'fullName', 'name', 'id', 'isFork', 'isPrivate', 'owner', 'url'].map(
        (key) => [key, repo[key] ?? null],
      ),
    )
  }
  return row
}
function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function records(value: JsonValue | undefined): Row[] {
  return Array.isArray(value) ? value.map(record) : []
}

function human(kind: string, rows: Row[], values: unknown[], both: boolean): string {
  const lines: string[] = []
  const clean = (value: JsonValue | undefined): string => str(value).trim().split(/\s+/).join(' ')
  rows.forEach((row, i) => {
    const raw = record(values[i]),
      repo = record(row.repository)
    let cells: string[]
    if (kind === 'issues' || kind === 'prs')
      cells = [
        ...(both ? [row.isPullRequest ? 'pr' : 'issue'] : []),
        str(repo.nameWithOwner),
        String(typeof row.number === 'number' ? row.number : 0),
        str(row.state),
        clean(row.title),
        records(row.labels)
          .map((label) => str(label.name))
          .join(', '),
        str(row.updatedAt),
      ]
    else if (kind === 'repos') {
      const tags = [
        str(row.visibility) || (row.isPrivate ? 'private' : 'public'),
        ...(row.isFork ? ['fork'] : []),
        ...(row.isArchived ? ['archived'] : []),
      ]
      cells = [str(row.fullName), clean(row.description), tags.join(', '), str(row.updatedAt)]
    } else if (kind === 'commits') {
      const info = record(row.commit)
      cells = [
        str(repo.fullName),
        str(row.sha),
        clean(info.message),
        str(record(raw.author).login),
        str(record(info.author).date),
      ]
    } else {
      for (const match of records(row.textMatches)) {
        let offset = 0
        for (const line of str(match.fragment).split('\n')) {
          const end = offset + new TextEncoder().encode(line).length
          if (
            records(match.matches).some(
              (m) =>
                Array.isArray(m.indices) &&
                typeof m.indices[0] === 'number' &&
                m.indices[0] >= offset &&
                m.indices[0] < end,
            )
          )
            lines.push(`${str(repo.nameWithOwner)}:${str(row.path)}: ${line.trim()}\n`)
          offset = end + 1
        }
      }
      return
    }
    lines.push(`${cells.join('\t')}\n`)
  })
  return lines.join('')
}
