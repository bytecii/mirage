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

// CPython fnmatch matching semantics, matched directly rather than through a
// translated regular expression: a pattern comes from the caller (a glob, a
// find -name, a grep --include), and a regex built from it backtracks
// polynomially on a pattern like *a*a*a*b. Every token but * consumes one
// character, so returning to the last * on a mismatch is enough, and a
// match costs at most name length times pattern length. Deliberate
// divergences from CPython: always case-sensitive (no normcase, so this
// equals Python fnmatchcase), an invalid class range like [z-a] never
// matches instead of raising, and a leading ^ negates a class like ! does
// (bash/glibc semantics; CPython keeps ^ literal). Mirrors the Python
// mirage.utils.fnmatch wrapper.
export function fnmatch(name: string, pattern: string): boolean {
  let n = 0
  let p = 0
  let starP = -1
  let starN = 0
  while (n < name.length) {
    if (p < pattern.length) {
      const c = pattern[p]
      if (c === '*') {
        while (p < pattern.length && pattern[p] === '*') p += 1
        starP = p
        starN = n
        continue
      }
      const end = c === '[' ? classEnd(pattern, p) : -1
      if (end >= 0) {
        if (classMatches(pattern.slice(p + 1, end), name.charAt(n))) {
          p = end + 1
          n += 1
          continue
        }
      } else if (c === '?' || c === name[n]) {
        p += 1
        n += 1
        continue
      }
    }
    if (starP < 0) return false
    starN += 1
    n = starN
    p = starP
  }
  while (p < pattern.length && pattern[p] === '*') p += 1
  return p === pattern.length
}

// The index of the ] closing the class that opens at `open`, or -1 when
// none does and the [ is a literal. A ] right after the [ (or after its
// negation) is a member, not the close.
function classEnd(pattern: string, open: number): number {
  let j = open + 1
  if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) j += 1
  if (j < pattern.length && pattern[j] === ']') j += 1
  while (j < pattern.length && pattern[j] !== ']') j += 1
  return j < pattern.length ? j : -1
}

// Whether one character is in a class body. Members are literal (a
// backslash is a member too), a-z is a range, a - at either end is
// literal, and a class holding a range whose ends are out of order
// matches nothing. A body of just ! or ^ matches any character.
function classMatches(body: string, ch: string): boolean {
  if (body === '!' || body === '^') return true
  const negate = body.startsWith('!') || body.startsWith('^')
  const members = negate ? body.slice(1) : body
  let found = false
  let i = 0
  while (i < members.length) {
    const lo = members.charAt(i)
    if (members[i + 1] === '-' && i + 2 < members.length) {
      const hi = members.charAt(i + 2)
      if (lo > hi) return false
      if (lo <= ch && ch <= hi) found = true
      i += 3
    } else {
      if (lo === ch) found = true
      i += 1
    }
  }
  return found !== negate
}
