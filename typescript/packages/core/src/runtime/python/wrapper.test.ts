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
import { PathSpec } from '../../types.ts'
import { PyodideRuntime } from './pyodide.ts'
import { PYTHON_EVAL_WRAPPER, PYTHON_REPL_WRAPPER, PYTHON_WRAPPER } from './wrapper.ts'

// These constants are Python programs living inside TypeScript template
// literals, a combination with one sharp edge: a plain template literal
// processes backslash escapes before Python ever sees the text, so a
// lone `\n` written inside an embedded Python string literal becomes a
// REAL newline and truncates that literal. The symptom is remote from
// the cause -- every pyodide run dies with `pyodide_fatal_error`,
// including `print(42)` -- which is why this compiles each wrapper with
// the real CPython that is going to run it and names the one that broke.
//
// The literals are `String.raw` so the escapes mean what they say; that
// is the fix, and this is the backstop. Reading the .ts file and
// un-escaping it by hand is NOT a substitute: doing that models the
// escaping wrong and reports a false pass.
const WRAPPERS: readonly (readonly [string, string])[] = [
  ['PYTHON_WRAPPER', PYTHON_WRAPPER],
  ['PYTHON_EVAL_WRAPPER', PYTHON_EVAL_WRAPPER],
  ['PYTHON_REPL_WRAPPER', PYTHON_REPL_WRAPPER],
]

describe('embedded python wrappers', { timeout: 120_000 }, () => {
  it('distinguishes absent and empty stdin for script CLIs without changing ordinary globals', async () => {
    const rt = new PyodideRuntime()
    try {
      for (const [stdin, expected] of [
        [null, 'None'],
        [new Uint8Array(), "b''"],
      ] as const) {
        const result = await rt.run({
          code: 'print(argv); print(stdin)',
          prog: 'pager',
          args: ['one'],
          scriptCli: true,
          env: {},
          stdin,
        })
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe(`['pager', 'one']\n${expected}\n`)
      }
      const ordinary = await rt.run({
        code: "print('argv' in globals(), 'stdin' in globals())",
        prog: '/work/script.py',
        args: [],
        env: {},
        stdin: null,
      })
      expect(new TextDecoder().decode(ordinary.stdout)).toBe('False False\n')
    } finally {
      await rt.close()
    }
  })

  it('every wrapper compiles on the interpreter that runs it', async () => {
    const rt = new PyodideRuntime()
    try {
      for (const [name, src] of WRAPPERS) {
        const result = await rt.eval("compile(_src, _name, 'exec') and 'ok'", {
          inputs: { _src: src, _name: name },
        })
        expect(result.value, `${name} is not valid python`).toBe('ok')
      }
    } finally {
      await rt.close()
    }
  })
})

describe('Pyodide command cwd', { timeout: 120_000 }, () => {
  it('restores trusted cwd functions when user code replaces or deletes them', async () => {
    const rt = new PyodideRuntime()
    try {
      await rt.eval(
        "import os; os.makedirs('/tmp/a', exist_ok=True); os.makedirs('/tmp/b', exist_ok=True)",
      )
      const before = await rt.eval('import os; os.getcwd()')
      for (const code of [
        'import os; os.chdir = lambda _: None',
        "import os; del os.chdir; raise ValueError('expected')",
        "import os; os.getcwd = lambda: '/missing-cwd'",
        "import os; del os.getcwd; raise ValueError('expected')",
      ]) {
        await rt.run({ code, args: [], env: {}, stdin: null, cwd: PathSpec.fromStrPath('/tmp/a') })
        expect((await rt.eval('import os; os.getcwd()')).value).toBe(before.value)
        const next = await rt.run({
          code: 'from pathlib import Path; print(Path.cwd())',
          args: [],
          env: {},
          stdin: null,
          cwd: PathSpec.fromStrPath('/tmp/b'),
        })
        expect(next.exitCode).toBe(0)
        expect(new TextDecoder().decode(next.stdout)).toBe('/tmp/b\n')
      }
    } finally {
      await rt.close()
    }
  })

  it('isolates queued runs and restores cwd after success and errors', async () => {
    const rt = new PyodideRuntime()
    try {
      await rt.eval(
        "import os; os.makedirs('/tmp/a', exist_ok=True); os.makedirs('/tmp/b', exist_ok=True)",
      )
      const before = await rt.eval('import os; os.getcwd()')
      if (typeof before.value !== 'string') throw new Error('cwd must be a string')
      const results = await Promise.all(
        ['/tmp/a', '/tmp/b'].map((cwd) =>
          rt.run({
            code: "import os; print(os.getcwd()); os.chdir('/tmp'); raise ValueError('expected')",
            args: [],
            env: { PWD: '/wrong' },
            stdin: null,
            cwd: PathSpec.fromStrPath(cwd),
          }),
        ),
      )
      expect(results.map((r) => new TextDecoder().decode(r.stdout))).toEqual([
        '/tmp/a\n',
        '/tmp/b\n',
      ])
      expect(results.map((r) => r.exitCode)).toEqual([1, 1])
      expect((await rt.eval('import os; os.getcwd()')).value).toBe(before.value)
      const missing = await rt.run({
        code: "print('must not run')",
        args: [],
        env: {},
        stdin: null,
        cwd: PathSpec.fromStrPath('/missing-cwd'),
      })
      expect(missing.exitCode).toBe(1)
      expect(new TextDecoder().decode(missing.stdout)).toBe('')
      const fresh = await rt.run({
        code: 'import os; print(os.getcwd())',
        args: [],
        env: {},
        stdin: null,
      })
      expect(new TextDecoder().decode(fresh.stdout)).toBe(`${before.value}\n`)
    } finally {
      await rt.close()
    }
  })
})
