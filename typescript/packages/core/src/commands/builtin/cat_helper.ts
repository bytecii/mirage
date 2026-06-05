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

const ENC = new TextEncoder()
const NL = 0x0a

function formatLineNo(n: number): string {
  return String(n).padStart(6, ' ')
}

/**
 * Number lines like GNU `cat -n`: a 6-wide right-justified count followed by a
 * tab, then the line. A final line with no trailing newline keeps its missing
 * newline (no spurious `\n` is appended).
 */
export async function* numberLines(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let lineNo = 0
  let buf = new Uint8Array(0)
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue
    const merged = new Uint8Array(buf.byteLength + chunk.byteLength)
    merged.set(buf, 0)
    merged.set(chunk, buf.byteLength)
    buf = merged
    let nl = buf.indexOf(NL)
    while (nl >= 0) {
      lineNo += 1
      yield ENC.encode(`${formatLineNo(lineNo)}\t`)
      yield buf.subarray(0, nl + 1)
      buf = buf.subarray(nl + 1)
      nl = buf.indexOf(NL)
    }
  }
  if (buf.byteLength > 0) {
    lineNo += 1
    yield ENC.encode(`${formatLineNo(lineNo)}\t`)
    yield buf
  }
}
