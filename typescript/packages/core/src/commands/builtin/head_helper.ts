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

const NL = 0x0a

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b
  if (b.byteLength === 0) return a
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

/**
 * Emit the head of a stream like GNU `head`.
 *
 * Bytes (`bytesMode`): positive = first N bytes, negative = all but the last N
 * bytes, 0 = nothing. Lines (`lines`): positive = first N lines, negative = all
 * but the last N lines, 0 = nothing. A final line without a trailing newline is
 * preserved as-is (no newline is appended).
 */
export async function* headStream(
  source: AsyncIterable<Uint8Array>,
  lines: number,
  bytesMode: number | null,
): AsyncIterable<Uint8Array> {
  if (bytesMode !== null) {
    if (bytesMode === 0) return
    if (bytesMode > 0) {
      let remaining = bytesMode
      for await (const chunk of source) {
        if (chunk.byteLength >= remaining) {
          if (remaining > 0) yield chunk.subarray(0, remaining)
          return
        }
        yield chunk
        remaining -= chunk.byteLength
      }
      return
    }
    const keep = -bytesMode
    let buf: Uint8Array = new Uint8Array(0)
    for await (const chunk of source) {
      buf = concat(buf, chunk)
      if (buf.byteLength > keep) {
        yield buf.subarray(0, buf.byteLength - keep)
        buf = buf.subarray(buf.byteLength - keep)
      }
    }
    return
  }

  if (lines >= 0) {
    if (lines === 0) return
    let emitted = 0
    let buf: Uint8Array = new Uint8Array(0)
    for await (const chunk of source) {
      buf = concat(buf, chunk)
      let nl = buf.indexOf(NL)
      while (nl >= 0 && emitted < lines) {
        yield buf.subarray(0, nl + 1)
        buf = buf.subarray(nl + 1)
        emitted += 1
        nl = buf.indexOf(NL)
      }
      if (emitted >= lines) return
    }
    if (buf.byteLength > 0 && emitted < lines) yield buf
    return
  }

  const keep = -lines
  const recent: Uint8Array[] = []
  let buf: Uint8Array = new Uint8Array(0)
  for await (const chunk of source) {
    buf = concat(buf, chunk)
    let nl = buf.indexOf(NL)
    while (nl >= 0) {
      recent.push(buf.subarray(0, nl + 1))
      buf = buf.subarray(nl + 1)
      if (recent.length > keep) {
        const out = recent.shift()
        if (out !== undefined) yield out
      }
      nl = buf.indexOf(NL)
    }
  }
}
