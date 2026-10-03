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

import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { ByteSource } from '../../io/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { MountEntry } from '../mount/mount.ts'

export function wireMount(mount: MountEntry): void {
  const cmds = mount.resource.commands?.()
  if (cmds !== undefined) {
    for (const cmd of cmds) {
      if (cmd.filetype !== null) mount.register(cmd)
      else if (cmd.resource === null) mount.registerGeneral(cmd)
      else mount.register(cmd)
    }
  }
  for (const cmd of GENERAL_COMMANDS) {
    mount.registerGeneral(cmd)
  }
}

export function wireRegistry(reg: MountRegistry): void {
  for (const m of reg.allMounts()) wireMount(m)
}

export async function readBody(out: ByteSource | null): Promise<string> {
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return new TextDecoder().decode(buf)
}

export function decode(b: Uint8Array | null): string {
  if (b === null) return ''
  return new TextDecoder().decode(b)
}

export function fakeShell(exitCodes: number[] = []): {
  lines: string[]
  fn: (script: string, opts: { sessionId: string }) => Promise<IOResult>
} {
  const lines: string[] = []
  return {
    lines,
    fn: (script: string) => {
      lines.push(script)
      const code = exitCodes[lines.length - 1] ?? 0
      return Promise.resolve(
        new IOResult({ stdout: new TextEncoder().encode(`ran:${script}\n`), exitCode: code }),
      )
    },
  }
}

export function aBC(): Uint8Array {
  return new TextEncoder().encode('a b c')
}

export function ab(): Uint8Array {
  return new TextEncoder().encode('a b')
}
