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

interface NodeFs {
  readFileSync(path: string): Uint8Array
  writeFileSync(path: string, data: Uint8Array): void
}

async function tryLoadFs(): Promise<NodeFs | null> {
  const g = globalThis as unknown as { process?: { versions?: { node?: string } } }
  if (g.process?.versions?.node === undefined) return null
  try {
    const modName = 'node:fs'
    const mod = (await import(/* @vite-ignore */ modName)) as NodeFs
    return mod
  } catch {
    return null
  }
}

const nodeFs: NodeFs | null = await tryLoadFs()

export function readFileBytes(path: string): Uint8Array {
  if (nodeFs === null) throw new Error('readFileBytes: not available (node:fs unavailable)')
  return nodeFs.readFileSync(path)
}

export function writeFileBytes(path: string, data: Uint8Array): void {
  if (nodeFs === null) throw new Error('writeFileBytes: not available (node:fs unavailable)')
  nodeFs.writeFileSync(path, data)
}
