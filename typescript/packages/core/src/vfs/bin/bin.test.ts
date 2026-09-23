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
import { BinViewVFS } from './bin.ts'

describe('BinViewVFS', () => {
  it('registers reads and no writes', () => {
    const vfs = new BinViewVFS(
      () => ['ls'],
      (name) => name === 'ls',
    )
    const names = new Set(vfs.commands().map((cmd) => cmd.name))
    for (const name of ['cat', 'ls', 'stat']) expect(names.has(name)).toBe(true)
    for (const name of ['rm', 'touch', 'cp']) expect(names.has(name)).toBe(false)
    const ops = new Set(vfs.ops().map((op) => op.name))
    for (const name of ['read', 'readdir', 'stat']) expect(ops.has(name)).toBe(true)
    expect(ops.has('write')).toBe(false)
  })
})
