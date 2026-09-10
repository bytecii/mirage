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
import { strftime } from './strftime.ts'

const MOMENT = new Date(Date.UTC(2026, 0, 1, 0, 0, 1, 123))

describe('strftime GNU directives', () => {
  // Pinned against date 9.7: a width on %N keeps that many leading
  // digits and pads a wider one with zeros on the right, a width on %q
  // zero-pads on the left, and the flags change nothing on either.
  it.each([
    ['%N', '123000000'],
    ['%3N', '123'],
    ['%-N', '123000000'],
    ['%_3N', '123'],
    ['%03N', '123'],
    ['%6N', '123000'],
    ['%12N', '123000000000'],
    ['%q', '1'],
    ['%2q', '01'],
    ['%02q', '01'],
    ['%_2q', ' 1'],
    ['%-2q', '1'],
    ['%_3q', '  1'],
    ['%_q', '1'],
    ['%_-2q', '1'],
    ['%-_2q', ' 1'],
    ['%0_2q', ' 1'],
    ['%_02q', '01'],
    ['%^_2q', ' 1'],
    ['%%N', '%N'],
    ['%%q', '%q'],
    ['%Y/%q/%3N', '2026/1/123'],
    ['%-d|%_d|%5d|%^b|%#p', '1| 1|00001|JAN|am'],
    ['%0_d|%_0d|%-_d|%_-d|%-0d|%0-d', ' 1|01| 1|1|01|1'],
    ['%-3d|%_-3d|%-_3d|%0_3d|%_3d|%3d', '1|1|  1|  1|  1|001'],
    ['%_0e|%0_e|%3e|%03e|%_j|%0_j', '01| 1|  1|001|  1|  1'],
    ['%5b|%_5b|%05b|%-5b|%^_5b|%_^b', '  Jan|  Jan|00Jan|Jan|  JAN|JAN'],
    ['%+5Y|%+4Y|%+6Y|%+3Y|%+5G|%+3C|%+C', '+2026|2026|+02026|2026|+2026|+20|20'],
    [
      '%+5d|%+d|%+5b|%+2q|%_+5Y|%+_5Y|%+05Y|%0+5Y|%-+5Y|%+-5Y',
      '00001|01|00Jan|01|+2026| 2026|02026|+2026|+2026|2026',
    ],
  ])('%s renders %s', (fmt, expected) => {
    expect(strftime(MOMENT, fmt, true)).toBe(expected)
  })
})
