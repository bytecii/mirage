import { IOResult } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { sizeSuffixes } from '../utils/size_suffix.ts'

// GNU truncate's letter set differs from split's and od's: lowercase
// g/k/m/t are accepted, b is not (pinned against coreutils 9.7).
const UNITS = sizeSuffixes('EGKMPQRTYZgkmt')
const OFF_T_MAX = 2 ** 63 - 1

// GNU rejects anything strtol would not consume whole, so `1x`, ` 5` and
// `1_0` are all `Invalid number` rather than a silently truncated read.
// parseInt would take the numeric prefix of `1x` and hand back NaN for
// `abc`, and NaN reaches the backend truncate op as a length, where
// `new Uint8Array(NaN)` empties the file.
const DIGITS = /^\d+$/

function parseSize(value: string, current: number): number {
  const first = value.slice(0, 1)
  const operation = ['+', '-', '<', '>', '/', '%'].includes(first) ? first : ''
  const raw = operation === '' ? value : value.slice(1)
  const suffix = Object.keys(UNITS)
    .sort((a, b) => b.length - a.length)
    .find((unit) => raw.endsWith(unit))
  const numeric = suffix === undefined ? raw : raw.slice(0, -suffix.length)
  if (!DIGITS.test(numeric)) throw new UsageError(`truncate: Invalid number: '${value}'`, 1)
  const number = Number.parseInt(numeric, 10) * (suffix === undefined ? 1 : (UNITS[suffix] ?? 1))
  if (number > OFF_T_MAX) {
    throw new UsageError(
      `truncate: Invalid number: '${value}': Value too large for defined data type`,
      1,
    )
  }
  if (number === 0 && (operation === '/' || operation === '%')) {
    throw new UsageError('truncate: division by zero', 1)
  }
  if (operation === '+') return current + number
  if (operation === '-') return Math.max(0, current - number)
  if (operation === '<') return Math.min(current, number)
  if (operation === '>') return Math.max(current, number)
  if (operation === '/') return current - (current % number)
  if (operation === '%') return Math.ceil(current / number) * number
  return number
}

export async function truncateGeneric(
  paths: readonly PathSpec[],
  size: string,
  stat: (path: PathSpec) => Promise<FileStat>,
  truncate: (path: PathSpec, length: number) => Promise<void>,
): Promise<CommandFnResult> {
  if (paths.length === 0) throw new Error('truncate: missing file operand')
  for (const path of paths) {
    const current = (await stat(path)).size ?? 0
    await truncate(path, parseSize(size, current))
  }
  return [null, new IOResult()]
}
