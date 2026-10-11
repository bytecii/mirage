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
import { PathSpec } from '@struktoai/mirage-core/types'
import { SSHAccessor } from '../../accessor/ssh.ts'
import { filesContaining, grepCommand } from './search.ts'

type Answer = [number | null, Uint8Array, Uint8Array] | Error

const ENC = new TextEncoder()

// An accessor whose server answers every command with `answer`. Twin of
// Python's _Accessor.
class FakeAccessor extends SSHAccessor {
  readonly sent: string[] = []

  constructor(
    root: string,
    private readonly answer: Answer,
  ) {
    super({ host: 'example.test', root })
  }

  override run(command: string): Promise<[number | null, Uint8Array, Uint8Array]> {
    this.sent.push(command)
    if (this.answer instanceof Error) return Promise.reject(this.answer)
    return Promise.resolve(this.answer)
  }
}

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/s' : `/s/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, rawPath: virtual })
}

function bytes(text: string): Uint8Array {
  return ENC.encode(text)
}

describe('grepCommand', () => {
  it('quotes the text and every scope', () => {
    expect(grepCommand("it's", ['data/a b'], true)).toBe(
      "env LC_ALL=C grep --dereference-recursive -lF --null -i -e 'it'\\''s' -- 'data/a b'",
    )
  })
})

describe('filesContaining', () => {
  it.each<[string, string, string, string, string[]]>([
    ['/', '', "'/'", '/a.txt\0/sub/c.txt\0', ['a.txt', 'sub/c.txt']],
    ['data', 'sub', "'data/sub'", 'data/sub/c.txt\0', ['sub/c.txt']],
    ['/srv/data/', '', "'/srv/data'", '/srv/data/x\0', ['x']],
    ['data', '', "'data'", '', []],
  ])('names what grep lists under root %j', async (root, under, quoted, out, want) => {
    const accessor = new FakeAccessor(root, [out === '' ? 1 : 0, bytes(out), new Uint8Array()])
    const hits = await filesContaining(accessor, 'hello', [scope(under)], false)
    expect(hits?.map((p) => p.vfsPath)).toEqual(want)
    expect(accessor.sent).toEqual([`${grepCommand('hello', [], false)} ${quoted}`])
  })

  // Only a clean run answers: a file grep could not read (exit 2, which the
  // walk then reports), a grep refusing an option (busybox exits 1 for one),
  // a signal, a name outside the root or not UTF-8, and a server that runs no
  // command all leave every file to be read. Twin of
  // test_files_containing_leaves_an_unclean_run_to_the_scan.
  it.each<[string, Answer]>([
    ['exit 2', [2, bytes('/data/a.txt\0'), new Uint8Array()]],
    ['stderr', [1, new Uint8Array(), bytes('grep: unrecognized option\n')]],
    ['signal', [null, new Uint8Array(), new Uint8Array()]],
    ['outside', [0, bytes('/elsewhere/a\0'), new Uint8Array()]],
    [
      'not utf-8',
      [0, new Uint8Array([0x2f, 0x64, 0x61, 0x74, 0x61, 0x2f, 0xff, 0]), new Uint8Array()],
    ],
    ['no exec', new Error('no exec')],
  ])('leaves an unclean run to the scan: %s', async (_label, answer) => {
    const accessor = new FakeAccessor('/data', answer)
    expect(await filesContaining(accessor, 'hello', [scope()], false)).toBeNull()
  })
})
