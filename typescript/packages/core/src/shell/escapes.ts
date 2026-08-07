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

import { byteChar } from './bytes.ts'

// The ANSI-C escape table $'...' shares with bash's strtrans.c. \e/\E
// are here although printf lacks them; \c takes an argument here while
// printf's \c means stop, which is why the printf reader is not reused.
const SIMPLE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
}
const HEX = /[0-9a-fA-F]/
const OCTAL = /[0-7]/
const UNICODE_MAX = 0x10ffff

function scanHex(content: string, start: number, limit: number): string {
  let end = start
  while (end < content.length && end - start < limit && HEX.test(content[end] ?? '')) {
    end += 1
  }
  return content.slice(start, end)
}

/**
 * Decode the body of a $'...' word to the text it names.
 *
 * Follows bash 5.2 (lib/sh/strtrans.c, under a UTF-8 locale): simple
 * escapes, 1-3 octal digits with the value masked to a byte, \xHH
 * bytes, \u and \U code points, \cX control characters (X of `?` is
 * DEL, an escaped backslash counts as one operand), and any other or
 * incomplete escape kept verbatim, backslash included. A NUL truncates
 * the rest of this word segment, the C-string behavior; the segment
 * alone is cut, so `x$'a\0b'y` still expands to `xay`.
 */
export function decodeAnsiC(content: string): string {
  const out: string[] = []
  let i = 0
  while (i < content.length) {
    const char = content[i] ?? ''
    if (char !== '\\' || i + 1 === content.length) {
      out.push(char)
      i += 1
      continue
    }
    const marker = content[i + 1] ?? ''
    const simple = SIMPLE[marker]
    if (simple !== undefined) {
      out.push(simple)
      i += 2
      continue
    }
    if (OCTAL.test(marker)) {
      let end = i + 1
      while (end < content.length && end - i <= 3 && OCTAL.test(content[end] ?? '')) {
        end += 1
      }
      const value = parseInt(content.slice(i + 1, end), 8)
      if ((value & 0xff) === 0) return out.join('')
      out.push(byteChar(value))
      i = end
      continue
    }
    if (marker === 'x') {
      const digits = scanHex(content, i + 2, 2)
      if (digits === '') {
        out.push('\\x')
        i += 2
        continue
      }
      const value = parseInt(digits, 16)
      if (value === 0) return out.join('')
      out.push(byteChar(value))
      i += 2 + digits.length
      continue
    }
    if (marker === 'u' || marker === 'U') {
      const digits = scanHex(content, i + 2, marker === 'u' ? 4 : 8)
      if (digits === '') {
        out.push(`\\${marker}`)
        i += 2
        continue
      }
      const value = parseInt(digits, 16)
      if (value === 0) return out.join('')
      // A value past Unicode has no character; keep the escape
      // verbatim rather than throwing, like an unknown escape.
      if (value > UNICODE_MAX) out.push(content.slice(i, i + 2 + digits.length))
      else out.push(String.fromCodePoint(value))
      i += 2 + digits.length
      continue
    }
    if (marker === 'c') {
      if (i + 2 === content.length) {
        out.push('\\c')
        i += 2
        continue
      }
      const operand = content[i + 2] ?? ''
      i += 3
      if (operand === '\\' && content[i] === '\\') {
        // \c\\ spells an escaped backslash operand; both characters
        // belong to it.
        i += 1
      }
      const value = operand === '?' ? 0x7f : (operand.toUpperCase().codePointAt(0) ?? 0) & 0x1f
      if (value === 0) return out.join('')
      out.push(String.fromCharCode(value))
      continue
    }
    out.push(char + marker)
    i += 2
  }
  return out.join('')
}
