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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { decodeLine, encodeLine, prefixOf } from './grep_offsets.ts'

const SEPARATOR = new TextEncoder().encode('--\n')

/**
 * grep's context output, settled one line at a time.
 *
 * Selected lines and their context, grouped the way GNU groups them, with `--`
 * between groups. It holds only the last `beforeContext` lines nothing has
 * printed yet, and `finished` turns true once -m has selected its last line
 * and that line's trailing context is out, so a caller feeding it a stream can
 * stop reading there: a pipe that goes on past the answer is never waited on.
 *
 * `byteOffsets` is -b: every line carries the byte offset of its own start, a
 * context line renders it with `-` like every other field, and the `--` group
 * separator carries no fields at all. The rendered line is put back with
 * `encodeLine`, so a byte that is not valid UTF-8 prints as GNU prints it
 * rather than as U+FFFD.
 *
 * `label` is the file name every line leads with, followed by `:` on a
 * selected line and `-` on a context line; the `--` separator carries none.
 * `trailingMatches` is ripgrep's -m: once -m has selected its last line, a
 * line in that line's trailing context that would be selected prints as
 * selected, still counted as context; GNU prints it as context.
 */
export class ContextRenderer {
  // GNU selects no line at all under -m0, context and all, so there is
  // nothing to group and nothing to print.
  finished: boolean
  private readonly held: [number, string, number][] = []
  private index = -1
  private position = 0
  private selected = 0
  private lastPrinted = -1
  private afterLeft = 0

  constructor(
    private readonly pat: RegExp,
    private readonly invert: boolean,
    private readonly lineNumbers: boolean,
    private readonly maxCount: number | null,
    private readonly afterContext: number,
    private readonly beforeContext: number,
    private readonly byteOffsets = false,
    private readonly label: string | null = null,
    private readonly trailingMatches = false,
  ) {
    this.finished = maxCount === 0
  }

  // Render what one more line settles. `line` comes from `decodeLine` with its
  // terminator stripped, which is what makes its -b offset exact, and `width`
  // is its length in bytes.
  feed(line: string, width: number): Uint8Array[] {
    this.index += 1
    const start = this.position
    this.position += width + 1
    const out: Uint8Array[] = []
    const selecting = this.maxCount === null || this.selected < this.maxCount
    const hit = this.pat.test(line) !== this.invert
    this.pat.lastIndex = 0
    if (selecting && hit) {
      this.selected += 1
      const first = this.held[0]?.[0] ?? this.index
      if (this.lastPrinted >= 0 && first > this.lastPrinted + 1) out.push(SEPARATOR)
      for (const [number, text, at] of this.held) out.push(this.render(number, text, at, false))
      this.held.length = 0
      out.push(this.render(this.index, line, start, true))
      this.lastPrinted = this.index
      this.afterLeft = this.afterContext
    } else if (this.afterLeft > 0) {
      out.push(this.render(this.index, line, start, hit && this.trailingMatches))
      this.lastPrinted = this.index
      this.afterLeft -= 1
    } else {
      this.held.push([this.index, line, start])
      if (this.held.length > this.beforeContext) this.held.shift()
    }
    if (this.maxCount !== null && this.selected >= this.maxCount && this.afterLeft === 0) {
      this.finished = true
    }
    return out
  }

  private render(index: number, line: string, start: number, selected: boolean): Uint8Array {
    const fields = prefixOf(
      this.lineNumbers ? index + 1 : null,
      this.byteOffsets ? start : null,
      selected,
    )
    const name = this.label === null ? '' : `${this.label}${selected ? ':' : '-'}`
    return encodeLine(`${name}${fields}${line}\n`)
  }
}

/**
 * Render selected lines with their context, GNU's separators included. The
 * lines come from `decodeLine`: the -b offsets are counted back out of the
 * text, which is exact only for text read that way.
 */
export function grepContextLines(
  lines: readonly string[],
  pat: RegExp,
  invert: boolean,
  lineNumbers: boolean,
  maxCount: number | null,
  afterContext: number,
  beforeContext: number,
  byteOffsets = false,
  label: string | null = null,
  trailingMatches = false,
): Uint8Array[] {
  const renderer = new ContextRenderer(
    pat,
    invert,
    lineNumbers,
    maxCount,
    afterContext,
    beforeContext,
    byteOffsets,
    label,
    trailingMatches,
  )
  const out: Uint8Array[] = []
  for (const line of lines) {
    if (renderer.finished) break
    out.push(...renderer.feed(line, encodeLine(line).length))
  }
  return out
}

/** `grepContextLines` over a stream, read no further than it prints. */
export async function* grepContextStream(
  source: AsyncIterable<Uint8Array>,
  pat: RegExp,
  invert: boolean,
  lineNumbers: boolean,
  maxCount: number | null,
  afterContext: number,
  beforeContext: number,
  byteOffsets = false,
  label: string | null = null,
  trailingMatches = false,
): AsyncIterable<Uint8Array> {
  const renderer = new ContextRenderer(
    pat,
    invert,
    lineNumbers,
    maxCount,
    afterContext,
    beforeContext,
    byteOffsets,
    label,
    trailingMatches,
  )
  const lines = new AsyncLineIterator(source)
  while (!renderer.finished) {
    const next = await lines.next()
    if (next.done === true) return
    yield* renderer.feed(decodeLine(next.value), next.value.byteLength)
  }
}
