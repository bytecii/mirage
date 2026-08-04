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

import type { CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { splitGeneric } from './split.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const TRY = "\nTry 'split --help' for more information."

async function runSplit(
  flags: CommandOpts['flags'],
  input = 'l1\nl2\nl3\nl4\n',
): Promise<Record<string, string>> {
  const written: Record<string, string> = {}
  const opts = {
    stdin: ENC.encode(input),
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
  } as CommandOpts
  await splitGeneric(
    [],
    opts,
    () => {
      throw new Error('paths are empty; the source is stdin')
    },
    (p, data) => {
      written[p.mountPath.replace(/^\//, '')] = DEC.decode(data)
      return Promise.resolve()
    },
  )
  return written
}

describe('split flag values', () => {
  it('splits by a suffixed byte count', async () => {
    const written = await runSplit({ bytes: '1k' }, 'A'.repeat(1500))
    expect(written.xaa?.length).toBe(1024)
    expect(written.xab?.length).toBe(476)
  })

  it('honors a hex suffix start in base 16', async () => {
    const written = await runSplit({ hex_suffixes: '10', lines: '1' }, 'a\nb\n')
    expect(Object.keys(written).sort()).toEqual(['x10', 'x11'])
  })

  it('treats -a 0 as the default width instead of colliding names', async () => {
    // Regression: suffix length 0 rendered an empty suffix, so every
    // chunk landed on the same output path and only the last survived.
    const written = await runSplit({ suffix_length: '0', lines: '1' }, 'a\nb\n')
    expect(Object.keys(written).sort()).toEqual(['xaa', 'xab'])
  })

  // Regression: a junk -b fell through to line mode with lines_per_file=0
  // and wrote one output file per input line; junk -l swallowed the whole
  // input into a single file; junk -a collided every chunk onto one path.
  it.each([
    [{ bytes: 'abc' }, "split: invalid number of bytes: 'abc'"],
    [{ bytes: '0x10' }, "split: invalid number of bytes: '0x10'"],
    [{ bytes: '0' }, "split: invalid number of bytes: '0'"],
    [{ bytes: '1g' }, "split: invalid number of bytes: '1g'"],
    [{ lines: 'abc' }, "split: invalid number of lines: 'abc'"],
    [{ lines: '0' }, "split: invalid number of lines: '0'"],
    [{ lines: '1k' }, "split: invalid number of lines: '1k'"],
    [{ number: 'l/abc' }, "split: invalid number of chunks: 'abc'"],
    [{ number: '0' }, "split: invalid number of chunks: '0'"],
    [{ suffix_length: 'abc', lines: '1' }, "split: invalid suffix length: 'abc'"],
    [
      { numeric_suffixes: 'zz', lines: '1' },
      `split: 'zz': invalid start value for numerical suffix${TRY}`,
    ],
    [
      { hex_suffixes: 'zz', lines: '1' },
      `split: 'zz': invalid start value for hexadecimal suffix${TRY}`,
    ],
    [
      { numeric_suffixes: '100', lines: '1' },
      `split: numerical suffix start value is too large for the suffix length${TRY}`,
    ],
  ] as [CommandOpts['flags'], string][])(
    'rejects %j without writing anything',
    async (flags, message) => {
      let written: Record<string, string> = {}
      await expect(async () => {
        written = await runSplit(flags)
      }).rejects.toThrow(new UsageError(message, 1))
      expect(written).toEqual({})
    },
  )
})
