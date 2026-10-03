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

import { describe } from 'vitest'
import { expect } from 'vitest'
import { it } from 'vitest'
import { CLISpec } from '../../../commands/cli/types.ts'
import { IOResult } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { MountRegistry } from '../../mount/registry.ts'
import { Session } from '../../session/session.ts'
import { handleMan } from './index.ts'
import { wireRegistry, readBody, decode } from '../../fixtures/builtin_fixture.ts'

describe('handleMan', () => {
  it('renders header, description, and RESOURCES list for a known command', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = handleMan(['date'], s, reg)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body).toContain('# date')
    expect(body).toContain('## RESOURCES')
    expect(body).toMatch(/^- general$/m)
  })

  it('renders OPTIONS table when the spec has options', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = handleMan(['date'], s, reg)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body).toContain('## OPTIONS')
  })

  it('dedupes by resource kind across multiple mounts of the same resource', async () => {
    const reg = new MountRegistry(
      { '/ram-a/': new RAMResource(), '/ram-b/': new RAMResource() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = handleMan(['cat'], s, reg)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    const ramLines = body.split('\n').filter((l) => /^- ram\b/.test(l))
    expect(ramLines.length).toBe(1)
  })

  it('exits 1 with a clear error for unknown commands', () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [, io] = handleMan(['definitely-not-a-real-command-xyz'], s, reg)
    expect(io.exitCode).toBe(1)
    const errBytes = io.stderr instanceof Uint8Array ? io.stderr : null
    expect(decode(errBytes)).toContain('no entry for definitely-not-a-real-command-xyz')
  })

  it('groups commands by resource kind, cwd resource first, general last', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/ram/' })
    const [body, io] = handleMan([], s, reg)
    const out = await readBody(body)
    expect(io.exitCode).toBe(0)
    const ramIdx = out.indexOf('# ram')
    const generalIdx = out.indexOf('# general')
    expect(ramIdx).toBeGreaterThanOrEqual(0)
    expect(generalIdx).toBeGreaterThan(ramIdx)
  })

  it('dedupes when the same resource kind is mounted at multiple prefixes', async () => {
    const reg = new MountRegistry(
      { '/ram-a/': new RAMResource(), '/ram-b/': new RAMResource() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [body] = handleMan([], s, reg)
    const out = await readBody(body)
    const matches = (out.match(/^# ram\b/gm) ?? []).length
    expect(matches).toBe(1)
  })
})

describe('handleMan for installed CLIs', () => {
  function cliRegistry(): MountRegistry {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    reg.clis.install(
      'linear',
      new CLISpec({
        name: 'linear',
        description: 'Linear API client',
        subcommands: [
          new CLISpec({
            name: 'issue',
            description: 'Manage issues',
            aliases: ['i'],
            subcommands: [
              new CLISpec({
                name: 'create',
                description: 'Create one',
                fn: () => [null, new IOResult()],
              }),
            ],
          }),
        ],
      }),
    )
    return reg
  }

  it('renders an installed CLI', async () => {
    const [out, io] = handleMan(
      ['linear'],
      new Session({ sessionId: 't', cwd: '/' }),
      cliRegistry(),
    )
    expect(io.exitCode).toBe(0)
    const text = await readBody(out)
    expect(text).toContain('Usage: linear')
    expect(text).toContain('issue')
  })

  it('descends a verb path and resolves aliases', async () => {
    const reg = cliRegistry()
    const s = new Session({ sessionId: 't', cwd: '/' })
    const text = await readBody(handleMan(['linear', 'issue', 'create'], s, reg)[0])
    expect(text).toContain('Usage: linear issue create')
    expect(await readBody(handleMan(['linear', 'i', 'create'], s, reg)[0])).toBe(text)
  })

  it('names the whole line for an unknown verb', () => {
    const s = new Session({ sessionId: 't', cwd: '/' })
    const [out, io] = handleMan(['linear', 'bogus'], s, cliRegistry())
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    const errBytes = io.stderr instanceof Uint8Array ? io.stderr : null
    expect(decode(errBytes)).toBe('man: no entry for linear bogus\n')
  })

  it('lists installed CLIs in the bare index, before general', async () => {
    const s = new Session({ sessionId: 't', cwd: '/' })
    const text = await readBody(handleMan([], s, cliRegistry())[0])
    expect(text).toContain('# clis')
    expect(text).toContain('- linear — Linear API client')
    expect(text.indexOf('# clis')).toBeLessThan(text.indexOf('# general'))
  })
})
