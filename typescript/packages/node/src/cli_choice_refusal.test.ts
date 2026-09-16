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

import { describe, expect, it } from 'vitest'
import type { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { cliSpecFor } from '@struktoai/mirage-core/commands/cli/specs'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { HF } from './commands/cli/builtin/hf/index.ts'
import { HIMALAYA } from './commands/cli/builtin/himalaya/index.ts'
import { Workspace } from './workspace.ts'

const DEC = new TextDecoder()

// hf and himalaya are node CLIs, so core's registry does not know
// them; gh comes from there.
const SPEC_OF: Record<string, CLISpec> = { hf: HF, himalaya: HIMALAYA }

// The CLI-tier options that declare `choices` render through the same
// gnulib ARGMATCH block a coreutils command does, because a leaf parses
// with the ordinary spec machinery. What a CLI adds is the display path
// in place of a command name and argparse's exit 2, which an installed
// CLI always takes — it is never a GNU tool with a pinned exit of its own.
// The expectation is CHOSEN rather than measured: none of these is a GNU
// program. Lives here rather than in core because core's Workspace has no
// shell parser, and hf and himalaya are node CLIs. Mirrors python's
// `test_a_cli_leaf_refuses_a_choice_in_the_argmatch_block`.
describe('a CLI leaf refusing a choice', () => {
  it.each<[string, Record<string, unknown>, string, string, string, string[]]>([
    [
      'gh',
      { token: 't' },
      'gh issue list --state=x',
      'gh issue list',
      '--state',
      ['open', 'closed', 'all'],
    ],
    [
      'gh',
      { token: 't' },
      'gh pr list --state=x',
      'gh pr list',
      '--state',
      ['open', 'closed', 'merged', 'all'],
    ],
    [
      'hf',
      { token: 't' },
      'hf download --repo-type=x owner/repo file',
      'hf download',
      '--repo-type',
      ['model', 'dataset', 'space'],
    ],
    [
      'hf',
      { token: 't' },
      'hf repo create --space_sdk=x owner/repo',
      'hf repo create',
      '--space_sdk',
      ['gradio', 'streamlit', 'docker', 'static'],
    ],
    [
      'himalaya',
      { imap_host: 'h', smtp_host: 'h', username: 'u', password: 'p' },
      'himalaya message reply --posting-style=x 1',
      'himalaya message reply',
      '--posting-style',
      ['top', 'bottom'],
    ],
  ])('refuses %s in the argmatch block', async (name, config, line, path, option, choices) => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    ws.registerCli(name, SPEC_OF[name] ?? cliSpecFor(name), config)
    const result = await ws.execute(line)
    const valid = choices.map((c) => `  - '${c}'`).join('\n')
    expect(DEC.decode(result.stderr)).toBe(
      `${path}: invalid argument 'x' for '${option}'\n` +
        `Valid arguments are:\n${valid}\n` +
        `Try '${path} --help' for more information.\n`,
    )
    expect(result.exitCode).toBe(2)
    await ws.close()
  })
})
