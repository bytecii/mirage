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

import { NodeType } from './types.ts'
import { compareCodePoints } from '../utils/sort.ts'

// Bash arithmetic tokens: integer literals (base#value/decimal/hex/
// octal), variable names, then operators longest-first so `<<=` never
// lexes as `<<` + `=`.
export const ARITH_TOKEN = new RegExp(
  [
    '(\\d+#[0-9a-zA-Z@_]+|0[xX][0-9a-fA-F]+|\\d+)',
    '([A-Za-z_]\\w*)',
    '(<<=|>>=|\\*\\*|\\+\\+|--|<<|>>|<=|>=|==|!=|&&|\\|\\||\\+=|-=|\\*=|/=|%=|&=|\\^=|\\|=|[-+*/%<>=!~&|^?:(),])',
    '(\\s+)',
    '(.)',
  ].join('|'),
  'g',
)

export const ARITH_NAME = /^[A-Za-z_]\w*$/

// An element reference token the tokenizer stitched: the name adjacent
// to a bracket-matched subscript, whose interior is resolved by the
// element callbacks rather than the tokenizer (an associative key can
// hold characters no arithmetic token may).
export const ARITH_ELEM = /^([A-Za-z_]\w*)\[([\s\S]*)\]$/

export const ARITH_ASSIGN_OPS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '&=',
  '^=',
  '|=',
])

// Recursion budget for variables holding expressions (`x="1+2"; $((x))`),
// mirroring bash's expression recursion limit.
export const ARITH_MAX_DEPTH = 16

// What the shell calls itself when no script is running, bash's "bash".
// A nested `bash`/`sh` overrides it through Session.scriptName, and
// `Session.argv0` is the one place the two are folded together.
export const SHELL_ARGV0 = 'mirage'

// Node types whose failure never triggers `set -e` by shape alone.
// Lists are NOT exempt: bash exits when the command after the final
// `&&`/`||` fails; short-circuit failures set Session.errexitImmune
// instead, so the executor loops skip only those.
export const ERREXIT_EXEMPT_TYPES: ReadonlySet<string> = new Set<string>([NodeType.NEGATED_COMMAND])

// Every letter bash's `set` accepts, mapped to the `-o` name it is a
// synonym for. The full table is here rather than only the letters
// mirage acts on, because a letter left out is silently dropped: `set -C`
// read as "no such option, ignore" is exactly the silent-accept the
// fail-loud rule exists to stop, and it made noclobber unreachable by its
// own letter while `set -o noclobber` worked.
export const SET_FLAG_TO_OPTION: Readonly<Record<string, string>> = Object.freeze({
  a: 'allexport',
  b: 'notify',
  e: 'errexit',
  f: 'noglob',
  h: 'hashall',
  k: 'keyword',
  m: 'monitor',
  n: 'noexec',
  p: 'privileged',
  t: 'onecmd',
  u: 'nounset',
  v: 'verbose',
  x: 'xtrace',
  B: 'braceexpand',
  C: 'noclobber',
  E: 'errtrace',
  H: 'histexpand',
  P: 'physical',
  T: 'functrace',
})

// Every name GNU's `set -o` accepts, pinned from `set -o` on
// debian:stable-slim. mirage acts on a few and stores the rest, mirroring
// how a cluster letter naming no option is kept rather than refused. A
// name absent from here is the one thing bash rejects outright, and it
// rejects it with exit 2 — which is what keeps a silently-ignored
// `set -o physical` from looking supported.
export const SET_OPTION_NAMES: ReadonlySet<string> = new Set([
  'allexport',
  'braceexpand',
  'emacs',
  'errexit',
  'errtrace',
  'functrace',
  'hashall',
  'histexpand',
  'history',
  'ignoreeof',
  'interactive-comments',
  'keyword',
  'monitor',
  'noclobber',
  'noexec',
  'noglob',
  'nolog',
  'notify',
  'nounset',
  'onecmd',
  'physical',
  'pipefail',
  'posix',
  'privileged',
  'verbose',
  'vi',
  'xtrace',
])

const DEFAULT_ON: ReadonlySet<string> = new Set(['braceexpand', 'hashall', 'interactive-comments'])

// What each option reads as before anything sets it, pinned from
// `bash -c 'set -o'` on debian:stable-slim (5.2.37). Only three are on,
// and all three are on for a non-interactive shell too, so this is the
// table `set -o` prints rather than an interactive shell's.
export const SET_OPTION_DEFAULTS: ReadonlyMap<string, boolean> = new Map(
  [...SET_OPTION_NAMES].sort(compareCodePoints).map((name) => [name, DEFAULT_ON.has(name)]),
)

// Every name GNU's `shopt` accepts and what it reads as before anything
// sets it, pinned from `bash -c shopt` on debian:stable-slim (5.2.37),
// in bash's own listing order. Kept apart from SET_OPTION_NAMES because
// bash keeps two vocabularies, `set -o` and `shopt`, with `shopt -o` as
// the one bridge.
export const SHOPT_DEFAULTS: ReadonlyMap<string, boolean> = new Map([
  ['autocd', false],
  ['assoc_expand_once', false],
  ['cdable_vars', false],
  ['cdspell', false],
  ['checkhash', false],
  ['checkjobs', false],
  ['checkwinsize', true],
  ['cmdhist', true],
  ['compat31', false],
  ['compat32', false],
  ['compat40', false],
  ['compat41', false],
  ['compat42', false],
  ['compat43', false],
  ['compat44', false],
  ['complete_fullquote', true],
  ['direxpand', false],
  ['dirspell', false],
  ['dotglob', false],
  ['execfail', false],
  ['expand_aliases', false],
  ['extdebug', false],
  ['extglob', false],
  ['extquote', true],
  ['failglob', false],
  ['force_fignore', true],
  ['globasciiranges', true],
  ['globskipdots', true],
  ['globstar', false],
  ['gnu_errfmt', false],
  ['histappend', false],
  ['histreedit', false],
  ['histverify', false],
  ['hostcomplete', true],
  ['huponexit', false],
  ['inherit_errexit', false],
  ['interactive_comments', true],
  ['lastpipe', false],
  ['lithist', false],
  ['localvar_inherit', false],
  ['localvar_unset', false],
  ['login_shell', false],
  ['mailwarn', false],
  ['no_empty_cmd_completion', false],
  ['nocaseglob', false],
  ['nocasematch', false],
  ['noexpand_translation', false],
  ['nullglob', false],
  ['patsub_replacement', true],
  ['progcomp', true],
  ['progcomp_alias', false],
  ['promptvars', true],
  ['restricted_shell', false],
  ['shift_verbose', false],
  ['sourcepath', true],
  ['varredir_close', false],
  ['xpg_echo', false],
])

// `shopt` names mirage refuses to turn on rather than store: `extglob`
// changes what the parser accepts, and mirage's grammar has no such
// mode, so a stored `on` would promise a syntax that still fails to
// parse. Refusing is the honest answer until the parser learns it.
export const SHOPT_UNSUPPORTED: ReadonlySet<string> = new Set(['extglob'])
