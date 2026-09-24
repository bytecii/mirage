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

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError } from './errors.ts'
import { joinOutput, commitOutput, parseDiffFlags, renamesEnabled } from './diff_output.ts'
import {
  FULL_SHA,
  needsDecorations,
  oneline,
  presetBlock,
  renderTemplate,
  type CommitFacts,
  type Decorations,
} from './format.ts'
import { decorations, parseFlags, refCommits, select, type LogFlags } from './history.ts'
import { configBool, opened, type Repo } from './repo.ts'
import { splitRevisions } from './revparse.ts'
import { checkOperands, escaped, fatal } from './util.ts'
import { HEAD } from './constants.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * The text a log invocation prints for its selected commits.
 *
 * `format:` separates entries with a newline and ends without one, and an
 * entry that renders empty still claims its separator, so `--pretty=format:`
 * prints one newline per commit past the first. `tformat:` (and any bare `%`
 * string) terminates every entry, empty ones included - except that an empty
 * template prints nothing at all, which is how `--format=` stays silent.
 * The caller encodes through `encodeText` because `%xHH` names a raw byte.
 * Pinned against git 2.37 and 2.54.
 */
function rendered(
  commits: readonly CommitFacts[],
  flags: LogFlags,
  width: number,
  decor: Decorations | null,
): string {
  const fmt = flags.pretty
  if (fmt.kind === 'oneline') {
    const length = flags.abbrevCommit ? width : FULL_SHA
    const lines = commits.map((commit) =>
      flags.decorate ? renderTemplate('%h%d %s', commit, length, decor) : oneline(commit, length),
    )
    return lines.length > 0 ? `${lines.join('\n')}\n` : ''
  }
  if (fmt.kind === 'format' || fmt.kind === 'tformat') {
    const entries = commits.map((commit) =>
      renderTemplate(fmt.template ?? '', commit, width, decor, flags.date),
    )
    if (fmt.kind === 'tformat') {
      if (fmt.template === null || fmt.template === '') return ''
      return entries.map((text) => `${text}\n`).join('')
    }
    return entries.join('\n')
  }
  const lines: string[] = []
  commits.forEach((commit, index) => {
    if (index > 0) lines.push('')
    const block = presetBlock(commit, fmt.kind, width, flags.date)
    if (flags.decorate && block[0]?.startsWith('commit '))
      block[0] += renderTemplate('%d', commit, width, decor)
    lines.push(...block)
  })
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/**
 * The commits a log walks from and the commits it hides: the revisions and
 * ranges given, HEAD when there are none, plus every ref for --all.
 */
async function startingPoints(
  repo: Repo,
  revisions: readonly string[],
  flags: LogFlags,
): Promise<[CommitFacts[], CommitFacts[]]> {
  const [starts, hidden] = await splitRevisions(repo, revisions.length ? revisions : [HEAD])
  if (flags.allRefs) starts.push(...(await refCommits(repo)))
  return [starts, hidden]
}

/** Show commit logs. */
export async function log(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  try {
    checkOperands(texts, undefined, escaped(inv.argv))
    const parsed = parseFlags(fl)
    const repo = await opened(fl, doors)
    const [starts, hidden] = await startingPoints(repo, texts, parsed)
    const commits = await select(repo, starts, parsed, hidden)
    const decor =
      parsed.decorate || needsDecorations(parsed.pretty) ? await decorations(repo) : null
    let diffFlags = parseDiffFlags(fl, false)
    let out: string
    if (
      diffFlags.patch ||
      diffFlags.stat ||
      diffFlags.nameOnly ||
      diffFlags.nameStatus ||
      diffFlags.numstat ||
      diffFlags.shortstat ||
      diffFlags.summary ||
      diffFlags.raw
    ) {
      diffFlags = parseDiffFlags(
        fl,
        false,
        'off',
        true,
        await renamesEnabled(repo),
        await configBool(repo, 'core.quotepath', true),
      )
      const blocks: string[] = []
      for (const commit of commits) {
        const head = rendered([commit], parsed, repo.abbrev, decor)
        const bodies = await commitOutput(repo, commit, diffFlags)
        blocks.push(joinOutput(commit, head, bodies, parsed.pretty.kind, repo.abbrev))
      }
      out = blocks.join(['tformat', 'oneline'].includes(parsed.pretty.kind) ? '' : '\n')
    } else out = rendered(commits, parsed, repo.abbrev, decor)
    if (out === '') return [null, new IOResult()]
    return [encodeText(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
