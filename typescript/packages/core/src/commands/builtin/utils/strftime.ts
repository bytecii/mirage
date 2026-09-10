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

// GNU date's format directives, rendered the way `date +FMT` and
// `ls --time-style=+FMT` print them; `%q` and `%N` are the two GNU adds
// no C library strftime knows.
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

function dayOfYear(year: number, month: number, day: number): number {
  return Math.floor((Date.UTC(year, month, day) - Date.UTC(year, 0, 0)) / 86_400_000)
}

// ISO 8601 week-based year and week number (%G/%g/%V): the week belongs to
// the year holding its Thursday.
function isoWeekParts(year: number, month: number, day: number): [number, number] {
  const dow = new Date(Date.UTC(year, month, day)).getUTCDay()
  const isoDow = dow === 0 ? 7 : dow
  const thursday = new Date(Date.UTC(year, month, day + 4 - isoDow))
  const ty = thursday.getUTCFullYear()
  const yday = dayOfYear(ty, thursday.getUTCMonth(), thursday.getUTCDate())
  return [ty, Math.floor((yday - 1) / 7) + 1]
}

export function strftime(dt: Date, fmt: string, utc: boolean): string {
  const year = utc ? dt.getUTCFullYear() : dt.getFullYear()
  const month = utc ? dt.getUTCMonth() : dt.getMonth()
  const day = utc ? dt.getUTCDate() : dt.getDate()
  const dow = utc ? dt.getUTCDay() : dt.getDay()
  const hour = utc ? dt.getUTCHours() : dt.getHours()
  const minute = utc ? dt.getUTCMinutes() : dt.getMinutes()
  const second = utc ? dt.getUTCSeconds() : dt.getSeconds()
  return fmt.replace(/%([aAbBcCdDeFgGhHIjklMmnNpPqrRsStTuUVwWxXYyzZ%])/g, (_m, code: string) => {
    switch (code) {
      case 'a':
        return DAY_NAMES[dow] ?? ''
      case 'A': {
        const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        return full[dow] ?? ''
      }
      case 'b':
        return MONTH_NAMES[month] ?? ''
      case 'B': {
        const full = [
          'January',
          'February',
          'March',
          'April',
          'May',
          'June',
          'July',
          'August',
          'September',
          'October',
          'November',
          'December',
        ]
        return full[month] ?? ''
      }
      case 'c':
        // C-locale %c (%a %b %e %H:%M:%S %Y), what glibc renders and what
        // Python's strftime produces under LC_ALL=C.
        return `${DAY_NAMES[dow] ?? ''} ${MONTH_NAMES[month] ?? ''} ${String(day).padStart(2, ' ')} ${pad2(hour)}:${pad2(minute)}:${pad2(second)} ${pad4(year)}`
      case 'C':
        return pad2(Math.floor(year / 100))
      case 'd':
        return pad2(day)
      case 'D':
        return `${pad2(month + 1)}/${pad2(day)}/${pad2(year % 100)}`
      case 'F':
        return `${pad4(year)}-${pad2(month + 1)}-${pad2(day)}`
      case 'g':
        return pad2(isoWeekParts(year, month, day)[0] % 100)
      case 'G':
        return pad4(isoWeekParts(year, month, day)[0])
      case 'h':
        return MONTH_NAMES[month] ?? ''
      case 'H':
        return pad2(hour)
      case 'k':
        return String(hour).padStart(2, ' ')
      case 'l': {
        const h12l = hour % 12 === 0 ? 12 : hour % 12
        return String(h12l).padStart(2, ' ')
      }
      case 'n':
        return '\n'
      case 'N':
        return String((utc ? dt.getUTCMilliseconds() : dt.getMilliseconds()) * 1_000_000).padStart(
          9,
          '0',
        )
      case 'P':
        return hour < 12 ? 'am' : 'pm'
      case 'q':
        return String(Math.floor(month / 3) + 1)
      case 'r': {
        const h12r = hour % 12 === 0 ? 12 : hour % 12
        return `${pad2(h12r)}:${pad2(minute)}:${pad2(second)} ${hour < 12 ? 'AM' : 'PM'}`
      }
      case 'R':
        return `${pad2(hour)}:${pad2(minute)}`
      case 't':
        return '\t'
      case 'U':
        // Week of year, Sunday-first, week 00 before the first Sunday.
        return pad2(Math.floor((dayOfYear(year, month, day) + 6 - dow) / 7))
      case 'V':
        return pad2(isoWeekParts(year, month, day)[1])
      case 'W':
        // Week of year, Monday-first.
        return pad2(Math.floor((dayOfYear(year, month, day) + 6 - ((dow + 6) % 7)) / 7))
      case 'x':
        return `${pad2(month + 1)}/${pad2(day)}/${pad2(year % 100)}`
      case 'X':
        return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
      case 'I': {
        const h12 = hour % 12 === 0 ? 12 : hour % 12
        return pad2(h12)
      }
      case 'M':
        return pad2(minute)
      case 'm':
        return pad2(month + 1)
      case 'Y':
        return pad4(year)
      case 'y':
        return pad2(year % 100)
      case 'p':
        return hour < 12 ? 'AM' : 'PM'
      case 'S':
        return pad2(second)
      case 's':
        return String(Math.floor(dt.getTime() / 1000))
      case 'z':
        return utc ? '+0000' : formatTZOffset(dt)
      case 'Z':
        return utc ? 'UTC' : ''
      case 'e':
        return String(day).padStart(2, ' ')
      case 'T':
        return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
      case 'j': {
        const start = Date.UTC(year, 0, 0)
        const diff = (utc ? dt.getTime() : Date.UTC(year, month, day)) - start
        return String(Math.floor(diff / 86_400_000)).padStart(3, '0')
      }
      case 'w':
        return String(dow)
      case 'u':
        return String(dow === 0 ? 7 : dow)
      case '%':
        return '%'
      default:
        return ''
    }
  })
}

export function formatTZOffset(dt: Date): string {
  const offsetMin = -dt.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`
}
