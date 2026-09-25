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
import { PathSpec } from '../../../types.ts'
import { isStdin, operandLabel } from './stream.ts'

function operand(raw: string, virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: '/',
    vfsPath: virtual.slice(1),
    resolved: true,
    rawPath: raw,
  })
}

describe('operandLabel', () => {
  it('names only a dash stdin', () => {
    // GNU grep, head and tail call only `-` standard input: /dev/stdin reads
    // the same bytes and is named as the path it is.
    const dash = operand('-', '/-')
    const dev = operand('/dev/stdin', '/dev/stdin')
    expect([isStdin(dash), isStdin(dev)]).toEqual([true, true])
    expect(operandLabel(dash, '(standard input)')).toBe('(standard input)')
    expect(operandLabel(dev, '(standard input)')).toBe('/dev/stdin')
    expect(operandLabel(operand('a.txt', '/data/a.txt'), '-')).toBe('a.txt')
  })
})
