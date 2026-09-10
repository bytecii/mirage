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

import { DEFAULT_ASK_REASON } from '../../policy/constants.ts'
import { PolicyError } from '../../policy/errors.ts'
import { matchOp, ruleScope } from '../../policy/match/rule.ts'
import type { AdmissionRules, CommandRule, OpsContext } from '../../policy/types.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { pathHidden, pathVisible } from '../../utils/hidden.ts'
import { parseSessionProfile, type SessionProfile } from '../../policy/profile.ts'
import { ScriptSource } from '../../runtime/routing/types.ts'
import {
  applyProfile,
  compileCommands,
  compileProfile,
  narrow,
  narrowingOf,
  narrowProfile,
  narrowRestored,
  resolveProfile,
  withInline,
} from './resolve.ts'
import { Session } from './session.ts'
import { VarAttr } from '../../shell/variable.ts'

const POLICY_DOC = {
  policy: {
    script: new ScriptSource('export function preCommand() {\n  return null\n}\n', 'js'),
    runtime: 'quickjs',
  },
}

function readOp(virtual: string): OpsContext {
  return {
    op: 'read',
    path: new PathSpec({
      virtual,
      directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
      resourcePath: virtual,
      rawPath: virtual,
    }),
    write: false,
    prefix: '/other',
  }
}

const PROFILES: Record<string, SessionProfile> = {
  default: parseSessionProfile({
    cwd: '/scratch',
    env: { PAGER: 'cat' },
    mounts: { '/repo': 'r', '/scratch': 'rwx' },
  }),
  reviewer: parseSessionProfile({
    paths: { hide: ['/repo/.env'] },
    env: { ROLE: 'reviewer' },
  }),
}

describe('resolveProfile', () => {
  it('names objects and the default', () => {
    expect(resolveProfile(PROFILES, 'reviewer')).toBe(PROFILES.reviewer)
    expect(resolveProfile(PROFILES, null)).toBe(PROFILES.default)
    expect(resolveProfile({}, null)).toBeNull()
    const plain: SessionProfile = { cwd: '/x' }
    expect(resolveProfile(PROFILES, plain)).toBe(plain)
  })

  it('refuses an unknown name', () => {
    expect(() => resolveProfile(PROFILES, 'nope')).toThrow(PolicyError)
    expect(() => resolveProfile(PROFILES, 'nope')).toThrow('unknown profile "nope"')
  })
})

describe('withInline', () => {
  it('takes the weaker mode per mount', () => {
    const base = parseSessionProfile({ mounts: { '/a': 'rwx', '/b': 'r' } })
    const inline = parseSessionProfile({ mounts: { '/a': 'rw', '/c': 'rwx' } })
    const out = withInline(base, inline)
    // Every prefix either side names survives; a mount only the inline
    // document names is not a grant, since a mount the profile never named
    // was already reachable at its own mode.
    expect(out?.mounts?.get('/a')?.mode).toBe(MountMode.WRITE)
    expect(out?.mounts?.get('/b')?.mode).toBe(MountMode.READ)
    expect(out?.mounts?.get('/c')?.mode).toBe(MountMode.EXEC)
  })

  it('unions hides and lets inline presets win', () => {
    const out = withInline(
      parseSessionProfile({
        cwd: '/scratch',
        env: { PAGER: 'cat', A: '1' },
        paths: { hide: ['/repo/.env', '*.pem'] },
        vars: { hide: ['AWS_*'] },
      }),
      parseSessionProfile({
        cwd: '/repo',
        env: { A: '2' },
        paths: { hide: ['*.pem', '/repo/secrets'] },
        vars: { hide: ['SLACK_TOKEN'] },
      }),
    )
    expect(out?.cwd).toBe('/repo')
    expect(out?.env).toEqual({ PAGER: 'cat', A: '2' })
    expect(out?.paths).toEqual({ hide: ['/repo/.env', '*.pem', '/repo/secrets'] })
    expect(out?.vars).toEqual({ hide: ['AWS_*', 'SLACK_TOKEN'] })
  })

  it('merges one mount section', () => {
    const base = parseSessionProfile({
      mounts: {
        '/repo': {
          mode: 'rw',
          commands: { deny: ['rm'] },
          paths: { hide: ['/repo/.env'] },
        },
      },
    })
    const inline = parseSessionProfile({
      mounts: {
        '/repo': { commands: { ask: ['git push'] }, paths: { hide: ['/repo/secrets'] } },
      },
    })
    const entry = withInline(base, inline)?.mounts?.get('/repo')
    expect(entry?.mode).toBe(MountMode.WRITE)
    expect(entry?.commands?.deny?.map((r) => r.commands)).toEqual([['rm']])
    expect(entry?.commands?.ask?.map((r) => r.commands)).toEqual([['git push']])
    expect(entry?.paths).toEqual({ hide: ['/repo/.env', '/repo/secrets'] })
  })

  it('with one side missing is the other', () => {
    const p: SessionProfile = { cwd: '/x' }
    expect(withInline(null, p)).toBe(p)
    expect(withInline(p, null)).toBe(p)
    expect(withInline(null, null)).toBeNull()
  })

  it('adds ask and deny but refuses an allow list', () => {
    const base = parseSessionProfile({
      commands: { allow: ['ls', 'git', 'cat'], ask: ['git push'], deny: ['rm'] },
    })
    const inline = parseSessionProfile({
      commands: { deny: [{ reason: 'no', commands: ['mv'] }] },
    })
    const out = withInline(base, inline)
    // The allow list is the profile's alone, and the added rules land after
    // it: an inline document restricts, it never installs.
    expect(out?.commands?.allow).toEqual(['ls', 'git', 'cat'])
    expect(out?.commands?.ask?.map((r) => r.commands)).toEqual([['git push']])
    expect(out?.commands?.deny?.map((r) => r.commands)).toEqual([['rm'], ['mv']])
    expect(() => withInline(base, parseSessionProfile({ commands: { allow: ['wc'] } }))).toThrow(
      'not an allow list',
    )
    // And with no profile to add to: the refusal belongs to where the
    // document was written, so a workspace that happens to declare no
    // default profile must not quietly accept what one with a profile refuses.
    expect(() => withInline(null, parseSessionProfile({ commands: { allow: ['wc'] } }))).toThrow(
      'not an allow list',
    )
  })

  it('leaves a stated block alone when the other is bare', () => {
    const base = parseSessionProfile({ commands: { allow: ['ls'] } })
    expect(withInline(base, { cwd: '/x' })?.commands).toEqual(base.commands)
    const inline = parseSessionProfile({ commands: { deny: ['rm'] } })
    expect(withInline({ cwd: '/x' }, inline)?.commands).toEqual(inline.commands)
  })
})

describe('compileCommands', () => {
  it("lists mount rules before the profile's own", () => {
    const rules = compileCommands(
      parseSessionProfile({
        commands: { allow: ['ls'], deny: ['shutdown'] },
        mounts: {
          '/repo': {
            commands: {
              ask: ['git rebase'],
              deny: [{ reason: 'ro', commands: { rm: ['/repo/*.lock'] } }],
            },
          },
          '/scratch': 'r',
        },
      }),
    )
    expect(rules?.allow).toEqual(['ls'])
    // Every mount rule carries the root it was written under, which is
    // what scopes it to a line working inside that mount; its paths are
    // kept exactly as typed.
    expect(rules?.deny[0]).toEqual({
      reason: 'ro',
      commands: ['rm'],
      paths: ['/repo/*.lock'],
      mount: '/repo',
    })
    expect(rules?.deny[1]?.commands).toEqual(['shutdown'])
    expect(rules?.deny[1]?.mount).toBeUndefined()
    expect(rules?.ask[0]?.commands).toEqual(['git rebase'])
    expect(rules?.ask[0]?.mount).toBe('/repo')
    expect(rules?.ask[0]?.paths).toBeUndefined()
  })

  it('anchors a name pattern to its mount', () => {
    const rules = compileCommands(
      parseSessionProfile({
        mounts: { '/repo': { commands: { deny: [{ reason: 'no pems', paths: ['*.pem'] }] } } },
      }),
    )
    const rule = rules?.deny[0] ?? { reason: 'missing' }
    expect(rule.paths).toEqual(['/repo/*.pem'])
    // The stamp scopes the rule at admission, but the op door reads the
    // paths alone, so a raw name pattern refused a read in every other
    // mount too.
    const scope = ruleScope(rule)
    expect(matchOp(rule, scope, readOp('/repo/deep/key.pem'))).toBe(true)
    expect(matchOp(rule, scope, readOp('/other/key.pem'))).toBe(false)
  })

  it('is null when the profile states no rules', () => {
    expect(compileCommands({})).toBeNull()
    expect(compileCommands(parseSessionProfile({ commands: {} }))).toBeNull()
    expect(compileCommands(parseSessionProfile({ mounts: { '/repo': 'r' } }))).toBeNull()
  })
})

describe('compileProfile', () => {
  it('turns the document into session fields', () => {
    const out = compileProfile(
      parseSessionProfile({
        cwd: '/scratch',
        env: { ROLE: 'x' },
        mounts: { '/a': 'rw', '/b': 'r' },
        paths: { hide: ['/a/secrets', '*.key'] },
        vars: { hide: ['SLACK_TOKEN', 'AWS_*'] },
      }),
    )
    expect(out.mountModes).toEqual(
      new Map([
        ['/a', MountMode.WRITE],
        ['/b', MountMode.READ],
      ]),
    )
    expect(out.hiddenPaths).toEqual({ paths: ['/a/secrets'], patterns: ['*.key'] })
    expect(out.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: ['AWS_*'] })
    expect(out.env).toEqual({ ROLE: 'x' })
    expect(out.cwd).toBe('/scratch')
  })

  it('carries the name, which narrow stamps onto the session', () => {
    const profile = parseSessionProfile({ cwd: '/scratch' })
    expect(compileProfile(profile, 'reviewer').profile).toBe('reviewer')
    const session = new Session({ sessionId: 's1' })
    narrow(session, compileProfile(profile, 'reviewer'))
    expect(session.profile).toBe('reviewer')
    // A document passed without a name, and no document at all, leave
    // the session with no profile to report.
    expect(compileProfile(profile).profile).toBeNull()
    expect(compileProfile(null).profile).toBeNull()
    narrow(session, compileProfile(null))
    expect(session.profile).toBeNull()
  })

  it('collects the hides of every mount section, anchored to it', () => {
    const out = compileProfile(
      parseSessionProfile({
        paths: { hide: ['/shared/finance'] },
        mounts: {
          '/repo': { paths: { hide: ['/repo/.env', '*.pem'] } },
          '/scratch': 'r',
        },
      }),
    )
    // The set is one list for the whole session, so a name pattern
    // written under a mount has to carry the mount with it: raw, `*.pem`
    // would hide `/scratch/key.pem` too.
    expect(out.hiddenPaths).toEqual({
      paths: ['/shared/finance', '/repo/.env'],
      patterns: ['/repo/*.pem'],
    })
    expect(pathHidden(out.hiddenPaths, '/repo/deep/key.pem')).toBe(true)
    expect(pathHidden(out.hiddenPaths, '/scratch/key.pem')).toBe(false)
    // The profile's own hide is not a mount section's and stays global.
    const profile = compileProfile(parseSessionProfile({ paths: { hide: ['*.pem'] } }))
    expect(pathHidden(profile.hiddenPaths, '/scratch/key.pem')).toBe(true)
  })

  it('of a bare or absent profile states nothing', () => {
    const empty = compileProfile(null)
    expect(empty).toEqual({
      mountModes: null,
      hiddenPaths: null,
      hiddenVars: null,
      env: null,
      cwd: null,
      commands: null,
      script: null,
      shownPaths: null,
      hideReasons: [],
      profile: null,
    })
    expect(compileProfile({})).toEqual(empty)
    // A profile that names a mount without a mode narrows nothing: the
    // mount keeps whatever the workspace gave it.
    expect(compileProfile(parseSessionProfile({ mounts: { '/a': {} } })).mountModes).toBeNull()
  })
})

describe('narrow / applyProfile', () => {
  it('narrow stamps the uneditable fields, applyProfile seeds the rest', () => {
    const compiled = compileProfile(
      parseSessionProfile({
        cwd: '/a',
        env: { ROLE: 'x' },
        mounts: { '/a': 'rw' },
        paths: { hide: ['/a/secrets'] },
        vars: { hide: ['SLACK_TOKEN'] },
      }),
    )
    const narrowed = new Session({ sessionId: 's1' })
    narrow(narrowed, compiled)
    expect(narrowed.mountModes).toEqual(new Map([['/a', MountMode.WRITE]]))
    expect(narrowed.mountModes).not.toBe(compiled.mountModes)
    expect(narrowed.hiddenPaths).toEqual({ paths: ['/a/secrets'], patterns: [] })
    expect(narrowed.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
    expect(narrowed.cwd).toBe('/')
    expect(narrowed.env.ROLE).toBeUndefined()
    const applied = new Session({ sessionId: 's2' })
    applyProfile(applied, compiled)
    expect(applied.mountModes).toEqual(new Map([['/a', MountMode.WRITE]]))
    expect(applied.cwd).toBe('/a')
    expect(applied.env.ROLE).toBe('x')
    expect(applied.vars.ROLE?.attrs.has(VarAttr.Export)).toBe(true)
  })

  it("carries the profile's admission rules onto the session", () => {
    const compiled = compileProfile(
      parseSessionProfile({ commands: { allow: ['ls'], ask: ['git'] } }),
    )
    expect(compiled.commands).toEqual({
      allow: ['ls'],
      ask: [{ reason: DEFAULT_ASK_REASON, commands: ['git'] }],
      deny: [],
    })
    const session = new Session({ sessionId: 's' })
    narrow(session, compiled)
    expect(session.commands).toEqual(compiled.commands)
    expect(compileProfile({ cwd: '/x' }).commands).toBeNull()
  })
})

describe('the path axis through resolve', () => {
  it("withInline cannot add show and the profile's survives", () => {
    const base = parseSessionProfile({
      paths: {
        hide: [{ patterns: ['/repo'], reason: 'sealed' }],
        show: ['/repo/public'],
      },
    })
    const inline = parseSessionProfile({
      paths: { hide: [{ patterns: ['/repo/extra'], reason: 'audit' }] },
    })
    const out = withInline(base, inline)
    // The profile's show and both sides' reasons survive the merge.
    expect(out?.paths?.show).toEqual([{ path: '/repo/public', mode: null }])
    expect(out?.paths?.hide).toEqual(['/repo', '/repo/extra'])
    expect(out?.paths?.reasons).toEqual([
      { patterns: ['/repo'], reason: 'sealed' },
      { patterns: ['/repo/extra'], reason: 'audit' },
    ])
    expect(() =>
      withInline(base, parseSessionProfile({ paths: { show: ['/repo/secrets'] } })),
    ).toThrow('not show entries')
    // The mount-section spelling is the same statement.
    expect(() =>
      withInline(
        base,
        parseSessionProfile({ mounts: { '/repo': { paths: { show: ['/repo/secrets'] } } } }),
      ),
    ).toThrow('not show entries')
    // And with no profile to add to, same rule as the allow list.
    expect(() => withInline(null, parseSessionProfile({ paths: { show: ['/x'] } }))).toThrow(
      'not show entries',
    )
  })

  it("withInline keeps a mount section's show", () => {
    const base = parseSessionProfile({
      mounts: { '/repo': { paths: { hide: ['/repo'], show: { '/repo/public': 'r' } } } },
    })
    const inline = parseSessionProfile({
      mounts: { '/repo': { paths: { hide: ['/repo/extra'] } } },
    })
    const entry = withInline(base, inline)?.mounts?.get('/repo')
    expect(entry?.paths?.show).toEqual([{ path: '/repo/public', mode: MountMode.READ }])
    expect(entry?.paths?.hide).toEqual(['/repo', '/repo/extra'])
  })

  it('compileProfile collects the shows of every mount section', () => {
    const out = compileProfile(
      parseSessionProfile({
        paths: { hide: ['/repo'], show: ['/repo/public'] },
        mounts: { '/data': { paths: { hide: ['/data'], show: { '/data/out': 'rw' } } } },
      }),
    )
    expect(out.shownPaths).toEqual({
      entries: [
        { path: '/repo/public', mode: null },
        { path: '/data/out', mode: MountMode.WRITE },
      ],
    })
    // The axis reads them together: the show reopens its subtree.
    expect(pathVisible(out.hiddenPaths, out.shownPaths, '/repo/public/a')).toBe(true)
    expect(pathVisible(out.hiddenPaths, out.shownPaths, '/repo/x')).toBe(false)
  })

  it("compileProfile anchors a mount section's reasons", () => {
    const out = compileProfile(
      parseSessionProfile({
        paths: { reasons: [{ patterns: ['/shared'], reason: 'global' }] },
        mounts: {
          '/repo': { paths: { reasons: [{ patterns: ['*.pem'], reason: 'credentials' }] } },
        },
      }),
    )
    expect(out.hideReasons).toEqual([
      { patterns: ['/shared'], reason: 'global' },
      { patterns: ['/repo/*.pem'], reason: 'credentials' },
    ])
  })

  it('narrow stamps the path axis', () => {
    const compiled = compileProfile(
      parseSessionProfile({
        paths: { hide: [{ patterns: ['/repo'], reason: 'sealed' }], show: ['/repo/public'] },
      }),
    )
    const session = new Session({ sessionId: 's' })
    narrow(session, compiled)
    expect(session.shownPaths).toEqual(compiled.shownPaths)
    expect(session.hideReasons).toEqual(compiled.hideReasons)
    const empty = compileProfile(null)
    expect(empty.shownPaths).toBeNull()
    expect(empty.hideReasons).toEqual([])
  })
})

describe('narrowRestored', () => {
  const table = (init: ConstructorParameters<typeof Session>[0]): Session =>
    new Session({ ...init, sessionId: 'table' })

  it('takes the weaker mode over both key sets', () => {
    const session = new Session({
      sessionId: 's',
      mountModes: new Map([['/a', MountMode.WRITE]]),
    })
    narrowRestored(
      session,
      table({
        sessionId: 'table',
        mountModes: new Map([
          ['/a/', MountMode.READ],
          ['b', MountMode.EXEC],
        ]),
      }),
    )
    expect(session.mountModes).toEqual(
      new Map([
        ['/a', MountMode.READ],
        ['/b', MountMode.EXEC],
      ]),
    )
    // A table narrowing nothing leaves the session's own map in place.
    const modes = session.mountModes
    narrowRestored(
      session,
      table({ sessionId: 'table', mountModes: new Map([['/a', MountMode.EXEC]]) }),
    )
    expect(session.mountModes).toBe(modes)
  })

  it('unions hides in order without repeats', () => {
    const session = new Session({
      sessionId: 's',
      hiddenPaths: { paths: ['/x'], patterns: ['*.pem'] },
      hiddenVars: { names: ['A'], patterns: [] },
      hideReasons: [{ patterns: ['/x'], reason: 'sealed' }],
    })
    narrowRestored(
      session,
      table({
        sessionId: 'table',
        hiddenPaths: { paths: ['/y', '/x'], patterns: ['*.key', '*.pem'] },
        hiddenVars: { names: ['A', 'B'], patterns: ['AWS_*'] },
        hideReasons: [
          { patterns: ['/x'], reason: 'sealed' },
          { patterns: ['/y'], reason: 'private' },
        ],
      }),
    )
    expect(session.hiddenPaths).toEqual({ paths: ['/x', '/y'], patterns: ['*.pem', '*.key'] })
    expect(session.hiddenVars).toEqual({ names: ['A', 'B'], patterns: ['AWS_*'] })
    expect(session.hideReasons).toEqual([
      { patterns: ['/x'], reason: 'sealed' },
      { patterns: ['/y'], reason: 'private' },
    ])
    // One side stating nothing takes the other's spec as it is.
    const bare = new Session({ sessionId: 'bare' })
    narrowRestored(bare, table({ sessionId: 'table', hiddenVars: { names: ['T'], patterns: [] } }))
    expect(bare.hiddenVars).toEqual({ names: ['T'], patterns: [] })
    expect(bare.hiddenPaths).toBeNull()
  })

  it('intersects allow lists and appends rules', () => {
    const denyRm: CommandRule = { reason: 'no', commands: ['rm'], paths: [], mount: '' }
    const denyMv: CommandRule = { reason: 'no', commands: ['mv'], paths: [], mount: '' }
    const askGit: CommandRule = { reason: 'ask', commands: ['git'], paths: [], mount: '' }
    const session = new Session({
      sessionId: 's',
      commands: { allow: ['git *', 'cat'], ask: [], deny: [denyRm] },
    })
    narrowRestored(
      session,
      table({
        sessionId: 'table',
        commands: { allow: ['git push', 'cat', 'ls'], ask: [askGit], deny: [denyRm, denyMv] },
      }),
    )
    expect(session.commands).toEqual({
      allow: ['git push', 'cat'],
      ask: [askGit],
      deny: [denyRm, denyMv],
    })
    // A list only one side states stands: it installs only what it lists.
    const one = new Session({ sessionId: 'one' })
    narrowRestored(
      one,
      table({ sessionId: 'table', commands: { allow: ['ls'], ask: [], deny: [] } }),
    )
    expect(one.commands).toEqual({ allow: ['ls'], ask: [], deny: [] })
    const other = new Session({
      sessionId: 'other',
      commands: { allow: ['ls'], ask: [], deny: [] },
    })
    narrowRestored(
      other,
      table({ sessionId: 'table', commands: { allow: null, ask: [], deny: [denyRm] } }),
    )
    expect(other.commands).toEqual({ allow: ['ls'], ask: [], deny: [denyRm] })
  })

  it('keeps a show only as both sides allow it', () => {
    const session = new Session({
      sessionId: 's',
      mountModes: new Map([['/repo', MountMode.READ]]),
      hiddenPaths: { paths: ['/repo/sealed'], patterns: [] },
      shownPaths: {
        entries: [
          { path: '/repo/sealed/public', mode: null },
          { path: '/repo/sealed/docs', mode: MountMode.WRITE },
          { path: '/repo/build', mode: null },
        ],
      },
    })
    narrowRestored(
      session,
      table({
        sessionId: 'table',
        shownPaths: {
          entries: [
            { path: '/repo/sealed/public', mode: null },
            { path: '/repo/sealed/docs', mode: MountMode.READ },
            { path: '/repo/sealed/other', mode: null },
            { path: '/repo/out', mode: MountMode.EXEC },
          ],
        },
      }),
    )
    expect(session.shownPaths).toEqual({
      entries: [
        // Both state it, neither with a mode: list-form on both sides.
        { path: '/repo/sealed/public', mode: null },
        // Both state a mode: the weaker.
        { path: '/repo/sealed/docs', mode: MountMode.READ },
        // Only the session states it and nothing hides it: kept.
        { path: '/repo/build', mode: null },
        // Only the table states it, nothing hides it, and its mode is
        // held under the session's cap at /repo. /repo/sealed/other,
        // only the table's, re-opens a hidden subtree and is dropped.
        { path: '/repo/out', mode: MountMode.READ },
      ],
    })
  })

  it('is the identity for a table from the same document', () => {
    const compiled = compileProfile(
      parseSessionProfile({
        mounts: {
          '/repo': {
            mode: 'rw',
            paths: {
              hide: [{ patterns: ['/repo/sealed'], reason: 'sealed' }],
              show: { '/repo/sealed/public': 'r' },
            },
            commands: { ask: ['git push'] },
          },
        },
        vars: { hide: ['AWS_*'] },
        commands: { allow: ['git *', 'ls', 'rm'], deny: ['rm'] },
      }),
      'named',
    )
    const session = new Session({ sessionId: 's' })
    narrow(session, compiled)
    const stored = Session.fromJSON(session.toJSON() as Parameters<typeof Session.fromJSON>[0])
    narrowRestored(session, stored)
    expect(session.commands).toBe(compiled.commands)
    expect(session.hiddenPaths).toBe(compiled.hiddenPaths)
    expect(session.hiddenVars).toBe(compiled.hiddenVars)
    expect(session.shownPaths).toBe(compiled.shownPaths)
    expect(session.hideReasons).toBe(compiled.hideReasons)
    expect(session.mountModes).toEqual(compiled.mountModes)
    expect(session.toJSON()).toEqual(stored.toJSON())
  })

  it("keeps the session's program and name", () => {
    const target = compileProfile(parseSessionProfile({ cwd: '/x' }), 'target')
    const session = new Session({ sessionId: 's' })
    narrow(session, target)
    const rules: AdmissionRules = {
      allow: null,
      ask: [],
      deny: [{ reason: 'no', commands: ['rm'], paths: [], mount: '' }],
    }
    narrowRestored(session, table({ sessionId: 'table', profile: 'other', commands: rules }))
    expect(session.profile).toBe('target')
    expect(session.script).toBe(target.script)
    expect(session.commands).toEqual(rules)
  })

  // A show is always stated against a hide, so reading the merged hide
  // set dropped every one-sided show under its own side's hide: a table
  // that simply never mentioned /vault took /vault/public away with it.
  it('keeps a one-sided show under its own hide', () => {
    const session = new Session({
      sessionId: 's',
      hiddenPaths: { paths: ['/vault'], patterns: [] },
      shownPaths: { entries: [{ path: '/vault/public', mode: null }] },
    })
    narrowRestored(session, table({ sessionId: 'table' }))
    expect(session.shownPaths).toEqual({ entries: [{ path: '/vault/public', mode: null }] })
    expect(pathVisible(session.hiddenPaths, session.shownPaths, '/vault/public')).toBe(true)
    // The same either way round: the table's show under the table's own
    // hide survives an unrestricted session.
    const other = new Session({ sessionId: 's' })
    narrowRestored(
      other,
      table({
        sessionId: 'table',
        hiddenPaths: { paths: ['/vault'], patterns: [] },
        shownPaths: { entries: [{ path: '/vault/public', mode: null }] },
      }),
    )
    expect(other.shownPaths).toEqual({ entries: [{ path: '/vault/public', mode: null }] })
  })

  // A pattern show is the same case: dropped only where the other side
  // hides at all, since no comparison proves which names it leaves open.
  it('keeps a one-sided pattern show when nothing on the other side hides', () => {
    const session = new Session({
      sessionId: 's',
      hiddenPaths: { paths: ['/work/aaa'], patterns: [] },
      shownPaths: { entries: [{ path: '/work/aaa/*.txt', mode: null }] },
    })
    narrowRestored(session, table({ sessionId: 'table' }))
    expect(session.shownPaths).toEqual({ entries: [{ path: '/work/aaa/*.txt', mode: null }] })
    const hidden = new Session({
      sessionId: 's',
      hiddenPaths: { paths: ['/work/aaa'], patterns: [] },
      shownPaths: { entries: [{ path: '/work/aaa/*.txt', mode: null }] },
    })
    narrowRestored(
      hidden,
      table({ sessionId: 'table', hiddenPaths: { paths: ['/work'], patterns: [] } }),
    )
    expect(hidden.shownPaths).toBeNull()
  })

  // Both sides hide /vault and both reach /vault/public/docs, one
  // through a broad carve-out and one through a narrow one. An
  // exact-path lookup found no counterpart for either entry, so each
  // was judged one-sided and dropped against the other side's /vault
  // hide, and the subtree both sides permit came back inaccessible. A
  // grant is a depth comparison, not a string match: the narrower
  // carve-out is the intersection.
  it('keeps a nested show both sides reach', () => {
    const session = new Session({
      sessionId: 's',
      hiddenPaths: { paths: ['/vault'], patterns: [] },
      shownPaths: { entries: [{ path: '/vault/public', mode: null }] },
    })
    narrowRestored(
      session,
      table({
        sessionId: 'table',
        hiddenPaths: { paths: ['/vault'], patterns: [] },
        shownPaths: { entries: [{ path: '/vault/public/docs', mode: null }] },
      }),
    )
    expect(session.shownPaths).toEqual({ entries: [{ path: '/vault/public/docs', mode: null }] })
    expect(pathVisible(session.hiddenPaths, session.shownPaths, '/vault/public/docs')).toBe(true)
    // Only the narrower grant survives: the broad one is not the
    // table's, and its siblings stay sealed.
    expect(pathVisible(session.hiddenPaths, session.shownPaths, '/vault/public/other')).toBe(false)
  })

  // The mode travels with the nesting: a narrow carve-out is held under
  // what the broad one allows above it, since a show scores deeper than
  // a per-mount cap and would otherwise lift it.
  it('holds a nested show under the broader mode', () => {
    const session = new Session({
      sessionId: 's',
      hiddenPaths: { paths: ['/vault'], patterns: [] },
      shownPaths: { entries: [{ path: '/vault/public', mode: MountMode.READ }] },
    })
    narrowRestored(
      session,
      table({
        sessionId: 'table',
        hiddenPaths: { paths: ['/vault'], patterns: [] },
        shownPaths: { entries: [{ path: '/vault/public/docs', mode: MountMode.WRITE }] },
      }),
    )
    expect(session.shownPaths).toEqual({
      entries: [{ path: '/vault/public/docs', mode: MountMode.READ }],
    })
  })
})

describe('narrowProfile', () => {
  const PROGRAM = parseSessionProfile(POLICY_DOC)

  it('joins restrictions onto a live session', () => {
    const session = new Session({
      sessionId: 's',
      mountModes: new Map([['/repo', MountMode.WRITE]]),
      hiddenPaths: { paths: ['/repo/live'], patterns: [] },
    })
    narrowProfile(
      session,
      compileProfile(
        parseSessionProfile({
          mounts: { '/repo': 'r' },
          paths: { hide: ['/repo/sealed'] },
          commands: { deny: ['rm'] },
        }),
        'named',
      ),
    )
    expect(session.mountModes).toEqual(new Map([['/repo', MountMode.READ]]))
    expect(pathHidden(session.hiddenPaths, '/repo/live')).toBe(true)
    expect(pathHidden(session.hiddenPaths, '/repo/sealed')).toBe(true)
    expect(session.profile).toBe('named')
  })

  // A program the host installed with setSessionProfile is the host's,
  // and a restore only adds restrictions: the name travels with it, so
  // a session never reports a group whose script it is not running.
  it('keeps a program the session already runs', () => {
    const running = compileProfile(PROGRAM, 'locked')
    const session = new Session({ sessionId: 's' })
    narrow(session, running)
    narrowProfile(session, compileProfile(parseSessionProfile({ cwd: '/x' }), 'wanted'))
    expect(session.script).toBe(running.script)
    expect(session.profile).toBe('locked')
  })

  it('takes the program of a session running none', () => {
    const wanted = compileProfile(PROGRAM, 'wanted')
    const session = new Session({ sessionId: 's' })
    narrowProfile(session, wanted)
    expect(session.script).toBe(wanted.script)
    expect(session.profile).toBe('wanted')
  })

  it('round trips through narrowingOf and narrow', () => {
    const compiled = compileProfile(
      parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { hide: ['/repo/sealed'], show: { '/repo/sealed/public': 'r' } },
        vars: { hide: ['AWS_*'] },
        commands: { deny: ['rm'] },
      }),
      'named',
    )
    const session = new Session({ sessionId: 's' })
    narrow(session, compiled)
    const before = session.toJSON()
    const saved = narrowingOf(session)
    narrowProfile(
      session,
      compileProfile(
        parseSessionProfile({ mounts: { '/repo': 'rwx' }, paths: { hide: ['/other'] } }),
        'wider',
      ),
    )
    expect(session.toJSON()).not.toEqual(before)
    narrow(session, saved)
    expect(session.toJSON()).toEqual(before)
  })
})
