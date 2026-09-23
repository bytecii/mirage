import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { createShellParser } from '../../../shell/parse/index.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { MountMode } from '../../../types.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../../../../integ/crossmount/program/files.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: { id: string; command: string; expect: { exit: number; stdout: string; stderr: string } }[]
}

describe('program file routing', () => {
  for (const test of corpus.cases) {
    it(test.id, async () => {
      const ws = new Workspace(
        { '/data': new RAMVFS(), '/data2': new RAMVFS() },
        {
          mode: MountMode.EXEC,
          shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
        },
      )
      try {
        const result = await ws.shell(test.command)
        const dec = new TextDecoder()
        expect({
          exit: result.exitCode,
          stdout: dec.decode(result.stdout),
          stderr: dec.decode(result.stderr),
        }).toEqual(test.expect)
      } finally {
        await ws.close()
      }
    })
  }
})
