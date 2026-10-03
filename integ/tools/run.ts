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

import { readFileSync } from 'node:fs'
import { MirageToolOperations } from '@struktoai/mirage-agents/tool_operations'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'

interface Case {
  id: string
  tool: string
  input: Record<string, unknown>
  expect: { text: string; is_error: boolean }
}

interface Suite {
  setup: string[]
  cases: Case[]
}

// The tool corpus in-app on the TypeScript host: each case runs through
// MirageToolOperations.call, the entry every door shares, on one
// workspace built by the corpus setup. Run from integ/:
//   pnpm exec tsx tools/run.ts
const suite = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf-8')) as Suite
const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
let failures = 0
try {
  for (const line of suite.setup) {
    const io = await ws.shell(line)
    if (io.exitCode !== 0) throw new Error(`setup failed: ${line}: ${io.stderrText}`)
  }
  const ops = new MirageToolOperations(ws)
  for (const c of suite.cases) {
    const result = await ops.call(c.tool, c.input)
    const got = { text: result.content[0]?.text ?? '', is_error: result.isError === true }
    if (got.text !== c.expect.text || got.is_error !== c.expect.is_error) {
      failures += 1
      console.log(`FAIL ${c.id}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`)
    }
  }
} finally {
  await ws.close()
}
console.log(
  `tools (typescript in-app): ${String(suite.cases.length - failures)}/${String(suite.cases.length)} passed`,
)
process.exitCode = failures === 0 ? 0 : 1
