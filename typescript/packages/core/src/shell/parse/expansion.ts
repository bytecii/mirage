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

import type { Node } from 'web-tree-sitter'
import { constructEnd } from './heredoc/line.ts'

/**
 * Parse substring operands as words, leaving arithmetic to evaluation.
 * GNU Bash 5.2 accepts malformed arithmetic until the word runs. A same-width
 * default operator selects tree-sitter's word grammar; verified tree reuse
 * restores the colon and original source without hiding nested substitutions
 * from policy or execution.
 */
export function expansionSource(text: string, root: Node): string {
  if (!text.includes('${')) return text
  const offsets: number[] = []
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    stack.push(...node.children)
    for (const [index, child] of node.children.entries()) {
      if (child.type !== '${') continue
      const tail = node.children.slice(index + 1)
      if (tail[0]?.type === '!') tail.shift()
      const reference = tail[0]
      const operator = tail[1]
      if (
        reference === undefined ||
        operator?.type !== ':' ||
        !['variable_name', 'special_variable_name', 'subscript'].includes(reference.type)
      )
        continue
      if (constructEnd(text, child.startIndex, '}') !== null) offsets.push(operator.startIndex)
    }
  }
  for (const offset of offsets) text = text.slice(0, offset) + '-' + text.slice(offset + 1)
  return text
}
