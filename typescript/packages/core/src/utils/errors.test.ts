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
import { enoent, formatFsError } from './errors.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('formatFsError', () => {
  it('prefixes a thrown command error with the command name (GNU prog: message)', () => {
    const line = decode(
      formatFsError(
        'slack-add-reaction',
        new Error('Slack API error (reactions.add): message_not_found'),
      ),
    )
    expect(line).toBe('slack-add-reaction: Slack API error (reactions.add): message_not_found\n')
  })

  it('stringifies a non-Error throw', () => {
    expect(decode(formatFsError('slack-add-reaction', 'boom'))).toBe('slack-add-reaction: boom\n')
  })

  it('does not double the prefix when the message already carries cmd:', () => {
    // Generic commands throw a fully GNU-formatted message (uniq: invalid
    // count); the prefix must not be doubled (uniq: uniq: ...).
    expect(decode(formatFsError('uniq', new Error("uniq: invalid count: '2junk'")))).toBe(
      "uniq: invalid count: '2junk'\n",
    )
  })

  it('renders a recognized filesystem error as cmd: path: strerror', () => {
    expect(decode(formatFsError('cat', enoent('/b/missing.txt')))).toBe(
      'cat: /b/missing.txt: No such file or directory\n',
    )
  })

  it('rewrites the resolved path to the as-typed spelling', () => {
    const line = decode(
      formatFsError('diff', enoent('/a/missing.txt'), [
        { virtual: '/a/missing.txt', rawPath: 'missing.txt' },
      ]),
    )
    expect(line).toBe('diff: missing.txt: No such file or directory\n')
  })
})
