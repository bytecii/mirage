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

export function gnuBasename(path: string, suffix?: string): string {
  let i = path.length
  while (i > 0 && path[i - 1] === '/') i--
  if (i === 0) return path.length > 0 ? '/' : ''
  const j = path.lastIndexOf('/', i - 1)
  let base = path.slice(j + 1, i)
  if (suffix !== undefined && suffix !== '' && base !== suffix && base.endsWith(suffix)) {
    base = base.slice(0, base.length - suffix.length)
  }
  return base
}

export function gnuDirname(path: string): string {
  if (path === '') return '.'
  let i = path.length
  while (i > 0 && path[i - 1] === '/') i--
  if (i === 0) return '/'
  let j = path.lastIndexOf('/', i - 1)
  if (j === -1) return '.'
  while (j > 0 && path[j - 1] === '/') j--
  if (j === 0) return '/'
  return path.slice(0, j)
}
