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
import { makeEnv, NATIVE_BACKENDS } from '../../tests/commands/native_fixture.ts'

describe.each(NATIVE_BACKENDS)('native echo (%s backend)', (kind) => {
  it.each([
    {
      name: 'echo basic matches native',
      command: 'echo hello world',
      nativeCommand: 'echo hello world',
    },
    {
      name: 'echo -n matches native',
      command: 'echo -n hello',
      nativeCommand: '/bin/echo -n hello',
    },
    {
      name: 'echo -e newline matches native printf',
      command: String.raw`echo -e 'hello\nworld'`,
      nativeCommand: String.raw`printf '%s\n' 'hello' 'world'`,
    },
    {
      name: 'echo -e tab matches native printf',
      command: String.raw`echo -e 'col1\tcol2'`,
      nativeCommand: String.raw`printf 'col1\tcol2\n'`,
    },
    {
      name: 'echo -e backslash matches native printf',
      command: String.raw`echo -e 'a\\b'`,
      nativeCommand: String.raw`printf 'a\\b\n'`,
    },
    {
      name: 'echo -e carriage return matches native printf',
      command: String.raw`echo -e 'hello\rbye'`,
      nativeCommand: String.raw`printf 'hello\rbye\n'`,
    },
    {
      name: 'echo -e mixed matches native printf',
      command: String.raw`echo -e 'a\tb\nc'`,
      nativeCommand: String.raw`printf 'a\tb\nc\n'`,
    },
    {
      name: 'echo -e without escapes matches native printf',
      command: 'echo -e hello',
      nativeCommand: String.raw`printf 'hello\n'`,
    },
  ])('$name', async ({ command, nativeCommand }) => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage(command)
      const n = await env.native(nativeCommand)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
