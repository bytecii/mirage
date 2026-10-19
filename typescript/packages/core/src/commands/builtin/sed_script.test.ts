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

import { describe, expect, it } from 'vitest'
import { AddressKind, SedError, compileScript, type SedScriptPiece } from './sed_script.ts'

function expr(...texts: string[]): SedScriptPiece[] {
  return texts.map((text) => ({ kind: 'expr', text }))
}

function refusal(pieces: SedScriptPiece[]): SedError {
  try {
    compileScript(pieces, false)
  } catch (err) {
    if (err instanceof SedError) return err
    throw err
  }
  throw new Error('compiled')
}

describe('compileScript', () => {
  it.each([
    ['k', "char 1: unknown command: `k'"],
    ['2 k', "char 3: unknown command: `k'"],
    ['2 ', 'char 2: missing command'],
    ['1,p', "char 3: unexpected `,'"],
    ['2!!d', "char 3: multiple `!'s"],
    ['2! !d', "char 4: multiple `!'s"],
    ['0p', 'char 2: invalid usage of line address 0'],
    ['0!p', 'char 2: invalid usage of line address 0'],
    ['0,5p', 'char 4: invalid usage of line address 0'],
    ['1,2q', 'char 4: command only uses one address'],
    ['1:a', "char 2: : doesn't want any addresses"],
    ['}', "char 1: unexpected `}'"],
    ['{p;1}', "char 5: `}' doesn't want any addresses"],
    ['{p', "char 0: unmatched `{'"],
    ['s/a/b', "char 5: unterminated `s' command"],
    ['s/a/b/k', "char 7: unknown option to `s'"],
    ['s/a/b/gg', "char 8: multiple `g' options to `s' command"],
    ['s/a/b/2g3', "char 9: multiple number options to `s' command"],
    ['s/o/O/0', "char 7: number option to `s' command may not be zero"],
    ['s/a/b/w', 'char 7: missing filename in r/R/w/W commands'],
    ['s/\\(/x/;p', 'char 8: Unmatched ( or \\('],
    ['/\\(/Ip', 'char 5: Unmatched ( or \\('],
    ['s/x/\\9/', "char 7: invalid reference \\9 on `s' command's RHS"],
    ['y/abc/xy/', "char 9: strings for `y' command are different lengths"],
    ['y/a/b/g', 'char 7: extra characters after command'],
    ['l 3x', 'char 4: extra characters after command'],
    [':', 'char 1: ":" lacks a label'],
    ['a', "char 1: expected \\ after `a', `c' or `i'"],
    ['\\%a', 'char 3: unterminated address regex'],
    ['//Ip', 'char 3: cannot specify modifiers on empty regexp'],
    ['v 9.0', 'char 5: expected newer version of sed'],
    ['e ls', "char 1: `e' command not supported"],
    ['s/\\c\\d/X/', 'char 9: recursive escaping after \\c not allowed'],
    ['s/a/\\c\\d/', 'char 9: recursive escaping after \\c not allowed'],
    ['y/a\\c\\d/XY/', 'char 8: recursive escaping after \\c not allowed'],
    ['a foo\\c\\dbar', 'char 12: recursive escaping after \\c not allowed'],
    ['s/\\c/X/', 'char 7: Trailing backslash'],
    ['s/a/b/\r', "char 7: unknown option to `s'"],
  ])("refuses %j with GNU's wording and place", (script, message) => {
    const err = refusal(expr(script))
    expect(err.message).toBe(`sed: -e expression #1, ${message}`)
    expect(err.exitCode).toBe(1)
  })

  it.each([
    [['s/a/b\\', 'c/'], "char 6: unterminated `s' command"],
    [['s/a\\', 'b/x/'], "char 4: unterminated `s' command"],
    [['/a\\', '/p'], 'char 3: unterminated address regex'],
    [['y/a\\', '/b/'], "char 4: unterminated `y' command"],
  ])('never continues %j into the next piece', (pieces, message) => {
    expect(refusal(expr(...pieces)).message).toBe(`sed: -e expression #1, ${message}`)
  })

  it('reads a y string before its escapes', () => {
    expect(compileScript(expr('y1a1\\x41'), false).commands[0]?.translit).toEqual(
      new Map([['a', '\x04']]),
    )
    expect(refusal(expr('y1a1\\x411')).message).toMatch(/char 9: extra characters after command$/)
  })

  it('continues a text into the next piece', () => {
    expect(compileScript(expr('a foo\\', 'bar'), false).commands[0]?.text).toBe('foo\nbar\n')
  })

  it('ends a text on a control escape as GNU does', () => {
    const texts = ['a foo\\c', 'i foo\\c', 'c foo\\c'].map(
      (script) => compileScript(expr(script), false).commands[0]?.text,
    )
    expect(texts).toEqual(['fooJ', 'foo\n', 'foo\n'])
  })

  it('names a piece and a file as GNU names them', () => {
    expect(refusal(expr('p', '2 k')).message).toMatch(/^sed: -e expression #2, char 3:/)
    expect(refusal(expr('2', 'p')).message).toBe('sed: -e expression #1, char 1: missing command')
    const pieces: SedScriptPiece[] = [
      { kind: 'expr', text: 'p' },
      { kind: 'file', text: 'p\n\n 2 k\n', name: '/s.sed' },
    ]
    expect(refusal(pieces).message).toBe("sed: file /s.sed line 3: unknown command: `k'")
  })

  it('exits four on a missing label and a colon class', () => {
    const label = refusal(expr('bfoo'))
    expect([label.exitCode, label.message]).toEqual([4, "sed: can't find label for jump to `foo'"])
    const colon = refusal(expr('s/[:alpha:]/x/'))
    expect([colon.exitCode, colon.message]).toEqual([
      4,
      'sed: character class syntax is [[:space:]], not [:space:]',
    ])
  })

  it('carries the w files opened before a refusal', () => {
    expect(refusal(expr('w /o', 'k')).wfiles).toEqual(['/o'])
  })

  it('reads addresses', () => {
    const program = compileScript(expr('1~0p;0~3p;2,~4p;/a/I,+2p;0,/x/p'), false)
    expect(program.commands[0]?.addr1?.kind).toBe(AddressKind.LINE)
    expect(program.commands[1]?.addr1?.kind).toBe(AddressKind.STEP)
    expect(program.commands.slice(2).map((cmd) => cmd.addr2?.kind)).toEqual([
      AddressKind.MULTIPLE,
      AddressKind.PLUS,
      AddressKind.REGEX,
    ])
  })

  it.each([
    ['a  one', 'one\n'],
    ['a\\   two', '   two\n'],
    ['a one\\/two\\tthree', 'one/two\tthree\n'],
    ['1a foo; 2d', 'foo; 2d\n'],
    ['a\\\n  l1\\\n  l2', '  l1\n  l2\n'],
    ['a\\\\', '\n'],
    ['a x\\ty\\', 'x\\ty\n'],
    ['a foo\\c\\\\bar', 'foo\x1cbar\n'],
  ])('reads the text of %j as GNU does', (script, text) => {
    expect(compileScript(expr(script), false).commands[0]?.text).toBe(text)
  })

  it('appends nothing for an empty text', () => {
    expect(compileScript(expr('a\\'), false).commands[0]?.text).toBeNull()
  })

  it('ends labels at blanks, semicolons and braces', () => {
    const program = compileScript(expr('2{bx};p;:x'), false)
    expect(program.commands.map((cmd) => cmd.name)).toEqual(['{', 'b', '}', 'p', ':'])
    expect(program.commands[1]?.target).toBe(4)
  })

  it('starts a comment at a hash after a label', () => {
    const program = compileScript(expr('b done#note', ':done#here'), false)
    expect(program.commands.map((cmd) => cmd.label)).toEqual(['done', 'done'])
    expect(program.commands[0]?.target).toBe(1)
  })

  it('takes both backslashes into a control backslash', () => {
    const program = compileScript(expr('s/\\c\\\\/\\c\\\\/;y/\\c\\\\/Z/'), false)
    const subst = program.commands[0]?.subst
    expect(subst?.regex.regex?.search('a\x1cb')).toEqual([[1, 2]])
    expect(subst?.parts.map((part) => part.text)).toEqual(['\x1c'])
    expect(program.commands[1]?.translit).toEqual(new Map([['\x1c', 'Z']]))
  })

  it('ends an s command at a CRLF', () => {
    const program = compileScript(expr('s/a/b/g\r\np'), false)
    expect(program.commands.map((cmd) => cmd.name)).toEqual(['s', 'p'])
  })

  it('capitalizes only ASCII letters in a control escape', () => {
    const program = compileScript(expr('s/\\c\udcdf/X/;s/\\ca/Y/'), false)
    expect(program.commands[0]?.subst?.regex.regex?.search('a\x9fb')).toEqual([[1, 2]])
    expect(program.commands[1]?.subst?.regex.regex?.search('a\x01b')).toEqual([[1, 2]])
  })

  it('keeps filenames shell text in the C locale', () => {
    const program = compileScript(expr('w /data/é', 'r /data/漢'), false)
    expect(program.wfiles).toEqual(['/data/é'])
    expect(program.commands[1]?.filename).toBe('/data/漢')
  })

  it('quiets a script that starts with #n', () => {
    expect(compileScript(expr('#n\n2p'), false).quiet).toBe(true)
    expect(compileScript(expr('p', '#n'), false).quiet).toBe(false)
    expect(compileScript(expr(' #n'), false).quiet).toBe(false)
  })

  it('lists the files in order', () => {
    const program = compileScript(expr('w /a', 's/x/y/w /b', 'r /c', 'R /d', 'W /a'), false)
    expect([program.wfiles, program.rfiles, program.readerFiles]).toEqual([
      ['/a', '/b'],
      ['/c'],
      ['/d'],
    ])
  })
})
