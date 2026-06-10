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

export function fnmatch(name: string, pattern: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '.')
    .replace(/\*/g, '.*')
  return new RegExp(`^${re}$`).test(name)
}

// Shell-expansion variant: also supports [...] character classes.
export function fnmatchCase(value: string, pattern: string): boolean {
  let re = '^'
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === undefined) break
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const end = pattern.indexOf(']', i)
      if (end === -1) {
        re += '\\['
      } else {
        re += pattern.slice(i, end + 1)
        i = end
      }
    } else if (/[.+^$(){}|\\]/.test(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
    i += 1
  }
  re += '$'
  return new RegExp(re).test(value)
}
