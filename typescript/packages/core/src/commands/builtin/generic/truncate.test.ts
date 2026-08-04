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

import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { UsageError } from '../../errors.ts'
import { truncateGeneric } from './truncate.ts'

function fPath(): PathSpec {
  return new PathSpec({
    virtual: '/f',
    directory: '/',
    resourcePath: 'f',
    resolved: true,
  })
}

async function runTruncate(size: string, current = 10): Promise<number[]> {
  const lengths: number[] = []
  await truncateGeneric(
    [fPath()],
    size,
    () => Promise.resolve(new FileStat({ name: 'f', type: FileType.TEXT, size: current })),
    (_p, length) => {
      lengths.push(length)
      return Promise.resolve()
    },
  )
  return lengths
}

describe('truncate sizes', () => {
  it('resolves plain and operation sizes', async () => {
    expect(await runTruncate('10', 0)).toEqual([10])
    expect(await runTruncate('+2', 10)).toEqual([12])
    expect(await runTruncate('-4', 10)).toEqual([6])
    expect(await runTruncate('%4', 10)).toEqual([12])
    expect(await runTruncate('/4', 10)).toEqual([8])
  })

  it('accepts the full GNU suffix alphabet', async () => {
    // truncate's letter set is not split's: lowercase g/k/m/t are valid
    // (pinned against coreutils 9.7), and E/P parse fine even though
    // most filesystems refuse the resulting size.
    expect(await runTruncate('1k')).toEqual([1024])
    expect(await runTruncate('1g')).toEqual([1024 ** 3])
    expect(await runTruncate('1t')).toEqual([1024 ** 4])
    expect(await runTruncate('1GiB')).toEqual([1024 ** 3])
    expect(await runTruncate('1GB')).toEqual([1000 ** 3])
    expect(await runTruncate('1mB')).toEqual([1000 ** 2])
    expect(await runTruncate('1E')).toEqual([1024 ** 6])
  })

  it.each(['abc', '', '1x1K', '2b', '5c', '1e'])(
    "rejects '%s' as an invalid number without touching the file",
    async (value) => {
      const truncateCalls: number[] = []
      await expect(
        truncateGeneric(
          [fPath()],
          value,
          () => Promise.resolve(new FileStat({ name: 'f', type: FileType.TEXT, size: 10 })),
          (_p, length) => {
            truncateCalls.push(length)
            return Promise.resolve()
          },
        ),
      ).rejects.toThrow(new UsageError(`truncate: Invalid number: '${value}'`, 1))
      expect(truncateCalls).toEqual([])
    },
  )

  it('reports off_t overflow with the Value-too-large tail', async () => {
    await expect(runTruncate('1Z')).rejects.toThrow(
      new UsageError("truncate: Invalid number: '1Z': Value too large for defined data type", 1),
    )
  })

  it('rejects division by zero', async () => {
    await expect(runTruncate('/0')).rejects.toThrow(new UsageError('truncate: division by zero', 1))
  })
})
