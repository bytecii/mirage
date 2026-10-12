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

import { ENCODING_LABELS, SINGLE_BYTE } from './generated/encoding_data.ts'

// The byte-order marks, each with the encoding it names.
export const BOMS: readonly (readonly [Uint8Array, string])[] = [
  [new Uint8Array([0xef, 0xbb, 0xbf]), 'UTF-8'],
  [new Uint8Array([0xff, 0xfe]), 'UTF-16LE'],
  [new Uint8Array([0xfe, 0xff]), 'UTF-16BE'],
]

const ASCII_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g

/**
 * The WHATWG encoding a label names, or null.
 *
 * Surrounding ASCII whitespace is dropped and ASCII case ignored, as the
 * standard's get-an-encoding reads a label. The replacement encoding's labels
 * name none. Mirrors Python's `encoding_for`.
 */
export function encodingFor(label: string): string | null {
  const trimmed = label.replace(ASCII_WHITESPACE, '')
  if (/[\u0080-\uffff]/.test(trimmed)) return null
  const key = trimmed.toLowerCase()
  return Object.hasOwn(ENCODING_LABELS, key) ? (ENCODING_LABELS[key] ?? null) : null
}

/**
 * The byte-order mark `data` starts with and the encoding it names. Mirrors
 * Python's `bom_of`.
 */
export function bomOf(data: Uint8Array): readonly [Uint8Array, string] | null {
  for (const [mark, name] of BOMS) {
    if (data.length >= mark.length && mark.every((b, i) => data[i] === b)) {
      return [mark, name]
    }
  }
  return null
}

/**
 * A streaming decoder for a WHATWG encoding: call it with each chunk and
 * whether it is the last. A byte sequence the encoding does not map decodes
 * to U+FFFD. A single-byte encoding reads its table, so both hosts decode it
 * exactly as the standard does; TextDecoder takes the rest, a mark left for
 * the caller. Mirrors Python's `decoder_for`.
 */
export function decoderFor(encoding: string): (data: Uint8Array, last: boolean) => string {
  const table = SINGLE_BYTE[encoding]
  if (table === undefined) {
    const decoder = new TextDecoder(encoding, { ignoreBOM: true })
    return (data, last) => decoder.decode(data, { stream: !last })
  }
  const units = Array.from({ length: 256 }, (_, b) => (b < 0x80 ? b : (table[b - 0x80] ?? 0xfffd)))
  // Spans keep String.fromCharCode under any engine's argument limit.
  const width = 8192
  return (data) => {
    const parts: string[] = []
    for (let start = 0; start < data.length; start += width) {
      const span = data.subarray(start, start + width)
      parts.push(String.fromCharCode(...Array.from(span, (b) => units[b] ?? 0xfffd)))
    }
    return parts.join('')
  }
}
