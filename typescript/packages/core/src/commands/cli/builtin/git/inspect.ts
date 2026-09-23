import git from 'isomorphic-git'

import { compareCodePoints } from '../../../../utils/sort.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError } from './errors.ts'
import { parseFlags, refCommits, select } from './history.ts'
import { commitFacts, opened, repoArgs } from './repo.ts'
import { loadRefs } from './refs.ts'
import { resolveCommit } from './revparse.ts'
import { checkOperands, escaped, fatal } from './util.ts'

const ENC = new TextEncoder()

export async function remote(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    checkOperands([...inv.texts], undefined, escaped(inv.argv))
    const repo = await opened(fl, inv.doors ?? {})
    const rows = (await git.listRemotes(repoArgs(repo))).sort((a, b) =>
      compareCodePoints(a.remote, b.remote),
    )
    const lines: string[] = []
    for (const row of rows) {
      if (!fl.asBool('verbose')) lines.push(row.remote)
      else {
        const urls = (await git.getConfigAll({
          ...repoArgs(repo),
          path: `remote.${row.remote}.url`,
        })) as string[]
        const push = (await git.getConfigAll({
          ...repoArgs(repo),
          path: `remote.${row.remote}.pushurl`,
        })) as string[]
        if (urls[0]) lines.push(`${row.remote}\t${urls[0]} (fetch)`)
        for (const url of push.length ? push : urls) lines.push(`${row.remote}\t${url} (push)`)
      }
    }
    return [ENC.encode(lines.length ? `${lines.join('\n')}\n` : ''), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

export async function config(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    const repo = await opened(fl, inv.doors ?? {})
    const key = inv.texts[0] ?? ''
    const value = (await git.getConfig({ ...repoArgs(repo), path: key })) as
      | string
      | boolean
      | undefined
    return [
      value === undefined ? null : ENC.encode(`${String(value)}\n`),
      new IOResult({ exitCode: value === undefined ? 1 : 0 }),
    ]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

export async function showRef(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    const repo = await opened(fl, inv.doors ?? {})
    const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
    const lines: string[] = []
    for (const ref of [...refs.keys()]
      .filter((r) => r.startsWith('refs/'))
      .sort(compareCodePoints)) {
      if (
        inv.texts.length &&
        !inv.texts.some((pattern) => ref === pattern || ref.endsWith(`/${pattern}`))
      )
        continue
      const oid = await git.resolveRef({ ...repoArgs(repo), ref })
      lines.push(`${oid} ${ref}`)
    }
    return [
      ENC.encode(lines.length ? `${lines.join('\n')}\n` : ''),
      new IOResult({ exitCode: lines.length ? 0 : 1 }),
    ]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

export async function revList(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    checkOperands([...inv.texts], undefined, escaped(inv.argv))
    const repo = await opened(fl, inv.doors ?? {})
    const flags = parseFlags(fl)
    const starts = flags.allRefs ? await refCommits(repo) : []
    for (const revision of inv.texts)
      starts.push(await commitFacts(repo, await resolveCommit(repo, revision)))
    if (!starts.length && !flags.allRefs)
      return [
        null,
        new IOResult({
          exitCode: 129,
          stderr: ENC.encode('usage: git rev-list [<options>] <commit>...\n'),
        }),
      ]
    const commits = await select(repo, starts, flags)
    const out = fl.asBool('count')
      ? `${String(commits.length)}\n`
      : commits.map((c) => `${c.oid}\n`).join('')
    return [ENC.encode(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
