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

import { RAMResource } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { Workspace } from './workspace.ts'

describe('Workspace.setFuseMountpoint', () => {
  it('starts null and round-trips', () => {
    const ws = new Workspace({ '/data/': new RAMResource() })
    expect(ws.fuseMountpoint).toBeNull()
    ws.setFuseMountpoint('/tmp/test')
    expect(ws.fuseMountpoint).toBe('/tmp/test')
    ws.setFuseMountpoint(null)
    expect(ws.fuseMountpoint).toBeNull()
  })

  it('tracks ownsFuseMount only when owned=true is passed', () => {
    const ws = new Workspace({ '/data/': new RAMResource() })
    expect(ws.ownsFuseMount).toBe(false)

    ws.setFuseMountpoint('/tmp/external')
    expect(ws.ownsFuseMount).toBe(false)

    ws.setFuseMountpoint('/tmp/owned', { owned: true })
    expect(ws.ownsFuseMount).toBe(true)

    ws.setFuseMountpoint(null)
    expect(ws.ownsFuseMount).toBe(false)
  })
})
