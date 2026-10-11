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

import type { CommandContext, AdmissionRules } from '../types.ts'
import { headAllowed, lineAllowed, lineTokens } from './allow.ts'

function ctx(
  command: string,
  extra: Partial<Omit<CommandContext, 'command'>> = {},
): CommandContext {
  return { command, paths: [], argv: [], cwd: '/', ...extra }
}

describe('allow lists', () => {
  it("headAllowed answers the profile's one allow list", () => {
    const rules: AdmissionRules = { allow: ['ls', 'git log'], ask: [], deny: [] }
    // A name is allowed when it starts a pattern of the list.
    expect(headAllowed('ls', rules)).toBe(true)
    expect(headAllowed('git', rules)).toBe(true)
    expect(headAllowed('cat', rules)).toBe(false)
    expect(headAllowed('rm', rules)).toBe(false)
    // A profile without a list allows everything, and so does no profile.
    expect(headAllowed('rm', { allow: null, ask: [], deny: [{ reason: 'x' }] })).toBe(true)
    expect(headAllowed('rm', null)).toBe(true)
  })

  it('lineAllowed reads the whole line and skips non-tools', () => {
    const rules: AdmissionRules = {
      allow: ['ls', 'git log', 'git status'],
      ask: [],
      deny: [],
    }
    expect(lineAllowed(ctx('ls', { argv: ['-la'], tokens: ['ls', '-la'] }), rules)).toBe(true)
    expect(lineAllowed(ctx('git', { tokens: ['git', 'log', '-1'] }), rules)).toBe(true)
    // The head is allowed (some git line is) but this line is
    // covered by no pattern.
    expect(lineAllowed(ctx('git', { tokens: ['git', 'push'] }), rules)).toBe(false)
    // A word that is not a tool is never refused by an allow list.
    expect(lineAllowed(ctx('cd', { tokens: ['cd', '/x'], tool: false }), rules)).toBe(true)
    // A context built without the entry point's tokens reads the raw argv.
    const raw = ctx('git', { argv: ['push'] })
    expect(lineTokens(raw)).toEqual(['git', 'push'])
    expect(lineAllowed(raw, rules)).toBe(false)
  })
})
