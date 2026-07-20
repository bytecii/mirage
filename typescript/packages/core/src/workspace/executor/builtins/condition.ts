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

import { evaluateArith } from '../../../shell/arith.ts'
import { ArithError, ExitSignal } from '../../../shell/errors.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { resolvePath, resolveSymlinks } from '../../../utils/path.ts'
import { IOResult } from '../../../io/types.ts'
import type { FileStat } from '../../../types.ts'
import { FileType, PathSpec } from '../../../types.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { toScope, scopePath } from './scope.ts'
import type { Result } from './scope.ts'

export type CondNode =
  | { kind: 'word'; value: string }
  | { kind: 'unary'; op: string; operand: string }
  | { kind: 'binary'; left: string; op: string; right: string; rightLiteral: boolean }
  | { kind: 'not'; inner: CondNode }
  | { kind: 'and'; left: CondNode; right: CondNode }
  | { kind: 'or'; left: CondNode; right: CondNode }

/** A test/[/[[ usage error: bash prints the message and returns 2. */
class CondError extends Error {}

interface CondContext {
  dispatch: DispatchFn
  namespace: Namespace
  session: Session
  name: string
}

const STRING_BINARY = new Set(['=', '==', '!='])
const NUMERIC_BINARY = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])
const FILE_PAIR_BINARY = new Set(['-nt', '-ot', '-ef'])
const STRING_UNARY = new Set(['-n', '-z'])
const FILE_UNARY = new Set(['-e', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h'])
// Real GNU operators mirage cannot answer (no pipe/socket/tty/owner model);
// failing loudly beats the silent-false this module used to produce.
const UNSUPPORTED_UNARY = new Set([
  '-p',
  '-S',
  '-b',
  '-c',
  '-g',
  '-k',
  '-u',
  '-O',
  '-G',
  '-N',
  '-t',
])
const BINARY_OPS = new Set([...STRING_BINARY, ...NUMERIC_BINARY, ...FILE_PAIR_BINARY])
const UNARY_OPS = new Set([...STRING_UNARY, ...FILE_UNARY, ...UNSUPPORTED_UNARY])

function isMissError(exc: unknown): boolean {
  const code = (exc as { code?: string }).code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return true
  const msg = exc instanceof Error ? exc.message : String(exc)
  return /not found|no such file|not a directory|is a directory/i.test(msg)
}

/**
 * Resolve an operand to 'dir' / 'file' / null plus its stat. Symlinks are
 * followed first; a stat naming a directory type answers directly, and a
 * readdir probe catches backends whose stat cannot see directories.
 */
async function pathKind(
  ctx: CondContext,
  val: string | PathSpec,
): Promise<['dir' | 'file' | null, FileStat | null]> {
  let scope: PathSpec
  if (val instanceof PathSpec) {
    scope = val
  } else {
    let resolved = resolvePath(val, ctx.session.cwd)
    resolved = resolveSymlinks(resolved, ctx.namespace.symlinkTargets())
    scope = toScope(resolved)
  }
  let stat: FileStat | null = null
  try {
    const [s] = await ctx.dispatch('stat', scope)
    stat = s as FileStat | null
  } catch (exc) {
    if (!isMissError(exc)) throw exc
  }
  if (stat !== null) {
    if (stat.type === FileType.DIRECTORY) return ['dir', stat]
    return ['file', stat]
  }
  try {
    await ctx.dispatch('readdir', scope)
    return ['dir', null]
  } catch (exc) {
    if (!isMissError(exc)) throw exc
    return [null, null]
  }
}

async function applyUnary(ctx: CondContext, op: string, val: string | PathSpec): Promise<boolean> {
  const text = scopePath(val)
  if (op === '-n') return text !== ''
  if (op === '-z') return text === ''
  if (op === '-L' || op === '-h') {
    const resolved = resolvePath(text, ctx.session.cwd)
    return ctx.namespace.isLink(resolved)
  }
  if (FILE_UNARY.has(op)) {
    if (!(val instanceof PathSpec) && text === '') return false
    const [kind, stat] = await pathKind(ctx, val)
    if (op === '-e') return kind !== null
    if (op === '-f') return kind === 'file'
    if (op === '-d') return kind === 'dir'
    if (op === '-s') {
      if (kind === 'dir') return true
      if (kind !== 'file' || stat === null) return false
      // Unknown API-backed sizes count as non-empty: the file exists
      // and hydration would be a full fetch per test.
      return stat.size === null || stat.size > 0
    }
    if (op === '-r' || op === '-w') {
      // Mirage has no per-user access model: whatever exists in a
      // mount is readable and writable through it.
      return kind !== null
    }
    if (op === '-x') {
      if (kind === 'dir') return true
      if (kind !== 'file' || stat === null) return false
      return stat.mode !== null && (stat.mode & 0o111) !== 0
    }
  }
  if (UNSUPPORTED_UNARY.has(op)) {
    throw new CondError(`${ctx.name}: ${op}: unsupported operator`)
  }
  throw new CondError(`${ctx.name}: ${op}: unary operator expected`)
}

function toInt(ctx: CondContext, text: string): bigint {
  const trimmed = text.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new CondError(`${ctx.name}: ${text}: integer expression expected`)
  }
  return BigInt(trimmed)
}

function compareInts(op: string, li: bigint, ri: bigint): boolean {
  if (op === '-eq') return li === ri
  if (op === '-ne') return li !== ri
  if (op === '-lt') return li < ri
  if (op === '-le') return li <= ri
  if (op === '-gt') return li > ri
  return li >= ri
}

function applyBinary(
  ctx: CondContext,
  left: string | PathSpec,
  op: string,
  right: string | PathSpec,
): boolean {
  const lt = scopePath(left)
  const rt = scopePath(right)
  if (op === '=' || op === '==') return lt === rt
  if (op === '!=') return lt !== rt
  if (NUMERIC_BINARY.has(op)) {
    const li = toInt(ctx, lt)
    const ri = toInt(ctx, rt)
    return compareInts(op, li, ri)
  }
  if (FILE_PAIR_BINARY.has(op)) {
    throw new CondError(`${ctx.name}: ${op}: unsupported operator`)
  }
  throw new CondError(`${ctx.name}: ${op}: binary operator expected`)
}

function evalOne(arg: string | PathSpec): boolean {
  return scopePath(arg) !== ''
}

function at(argv: (string | PathSpec)[], i: number): string | PathSpec {
  const v = argv[i]
  if (v === undefined) throw new CondError('argument expected')
  return v
}

async function evalTwo(ctx: CondContext, argv: (string | PathSpec)[]): Promise<boolean> {
  const first = scopePath(at(argv, 0))
  if (first === '!') return !evalOne(at(argv, 1))
  if (UNARY_OPS.has(first)) return applyUnary(ctx, first, at(argv, 1))
  throw new CondError(`${ctx.name}: ${first}: unary operator expected`)
}

async function evalThree(ctx: CondContext, argv: (string | PathSpec)[]): Promise<boolean> {
  const mid = scopePath(at(argv, 1))
  if (mid === '-a') {
    return evalOne(at(argv, 0)) && evalOne(at(argv, 2))
  }
  if (mid === '-o') {
    return evalOne(at(argv, 0)) || evalOne(at(argv, 2))
  }
  if (BINARY_OPS.has(mid)) {
    return applyBinary(ctx, at(argv, 0), mid, at(argv, 2))
  }
  const first = scopePath(at(argv, 0))
  if (first === '!') return !(await evalTwo(ctx, argv.slice(1)))
  if (first === '(' && scopePath(at(argv, 2)) === ')') {
    return evalOne(at(argv, 1))
  }
  throw new CondError(`${ctx.name}: ${mid}: binary operator expected`)
}

async function evalFour(ctx: CondContext, argv: (string | PathSpec)[]): Promise<boolean> {
  const first = scopePath(at(argv, 0))
  if (first === '!') return !(await evalThree(ctx, argv.slice(1)))
  if (first === '(' && scopePath(at(argv, 3)) === ')') {
    return evalTwo(ctx, argv.slice(1, 3))
  }
  return new ExprParser(ctx, argv).run()
}

/**
 * Recursive-descent `test` expression parser (>4 args, GNU expr grammar:
 * or -> and -> term with `!` and parentheses).
 */
class ExprParser {
  private pos = 0

  constructor(
    private readonly ctx: CondContext,
    private readonly argv: (string | PathSpec)[],
  ) {}

  private peek(offset = 0): string | null {
    const arg = this.argv[this.pos + offset]
    if (arg === undefined) return null
    return scopePath(arg)
  }

  async run(): Promise<boolean> {
    const result = await this.orExpr()
    if (this.pos !== this.argv.length) {
      throw new CondError(`${this.ctx.name}: too many arguments`)
    }
    return result
  }

  private async orExpr(): Promise<boolean> {
    let result = await this.andExpr()
    while (this.peek() === '-o') {
      this.pos += 1
      const right = await this.andExpr()
      result = result || right
    }
    return result
  }

  private async andExpr(): Promise<boolean> {
    let result = await this.term()
    while (this.peek() === '-a') {
      this.pos += 1
      const right = await this.term()
      result = result && right
    }
    return result
  }

  private async term(): Promise<boolean> {
    const tok = this.peek()
    if (tok === null) throw new CondError(`${this.ctx.name}: argument expected`)
    if (tok === '!') {
      this.pos += 1
      return !(await this.term())
    }
    if (tok === '(') {
      this.pos += 1
      const result = await this.orExpr()
      if (this.peek() !== ')') throw new CondError(`${this.ctx.name}: \`)' expected`)
      this.pos += 1
      return result
    }
    const nxt = this.peek(1)
    if (nxt !== null && BINARY_OPS.has(nxt) && this.peek(2) !== null) {
      const left = at(this.argv, this.pos)
      const right = at(this.argv, this.pos + 2)
      this.pos += 3
      return applyBinary(this.ctx, left, nxt, right)
    }
    if (UNARY_OPS.has(tok) && nxt !== null && nxt !== '-a' && nxt !== '-o') {
      const operand = at(this.argv, this.pos + 1)
      this.pos += 2
      return applyUnary(this.ctx, tok, operand)
    }
    this.pos += 1
    return tok !== ''
  }
}

/** Evaluate a flat test/[ argument list with bash's arity rules. */
async function evalFlat(ctx: CondContext, argv: (string | PathSpec)[]): Promise<boolean> {
  const n = argv.length
  if (n === 0) return false
  if (n === 1) return evalOne(at(argv, 0))
  if (n === 2) return evalTwo(ctx, argv)
  if (n === 3) return evalThree(ctx, argv)
  if (n === 4) return evalFour(ctx, argv)
  return new ExprParser(ctx, argv).run()
}

/** Evaluate a structured [[ ]] expression tree. */
async function evalCond(ctx: CondContext, node: CondNode): Promise<boolean> {
  if (node.kind === 'and') {
    return (await evalCond(ctx, node.left)) && (await evalCond(ctx, node.right))
  }
  if (node.kind === 'or') {
    return (await evalCond(ctx, node.left)) || (await evalCond(ctx, node.right))
  }
  if (node.kind === 'not') return !(await evalCond(ctx, node.inner))
  if (node.kind === 'unary') {
    if (!UNARY_OPS.has(node.op)) {
      throw new CondError('mirage: conditional unary operator expected')
    }
    return applyUnary(ctx, node.op, node.operand)
  }
  if (node.kind === 'binary') return evalCondBinary(ctx, node)
  return node.value !== ''
}

function evalCondBinary(ctx: CondContext, node: Extract<CondNode, { kind: 'binary' }>): boolean {
  if (node.op === '=' || node.op === '==') {
    if (node.rightLiteral) return node.left === node.right
    return fnmatch(node.left, node.right)
  }
  if (node.op === '!=') {
    if (node.rightLiteral) return node.left !== node.right
    return !fnmatch(node.left, node.right)
  }
  if (node.op === '=~') {
    const pattern = node.rightLiteral
      ? node.right.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : node.right
    let match: RegExpExecArray | null
    try {
      match = new RegExp(pattern).exec(node.left)
    } catch {
      throw new CondError('mirage: syntax error in conditional expression')
    }
    if (match === null) return false
    ctx.session.arrays.BASH_REMATCH = [
      match[0],
      ...match.slice(1).map((g: string | undefined) => g ?? ''),
    ]
    return true
  }
  if (node.op === '<') return node.left < node.right
  if (node.op === '>') return node.left > node.right
  if (NUMERIC_BINARY.has(node.op)) {
    // [[ evaluates numeric operands as arithmetic: variables resolve,
    // expressions compute, bare unset words are 0.
    let li: bigint
    let ri: bigint
    try {
      li = evaluateArith(node.left, ctx.session.env).value
      ri = evaluateArith(node.right, ctx.session.env).value
    } catch (exc) {
      if (!(exc instanceof ArithError)) throw exc
      throw new CondError('mirage: syntax error in conditional expression')
    }
    return compareInts(node.op, li, ri)
  }
  if (FILE_PAIR_BINARY.has(node.op)) {
    throw new CondError(`${ctx.name}: ${node.op}: unsupported operator`)
  }
  throw new CondError('mirage: conditional binary operator expected')
}

/**
 * Evaluate test/[ (flat argv) or [[ (condition tree). `name` is the
 * invocation spelling used in diagnostics: "test", "[", or "[[".
 */
export async function handleTest(
  dispatch: DispatchFn,
  namespace: Namespace,
  args: (string | PathSpec)[] | CondNode,
  session: Session,
  name = 'test',
): Promise<Result> {
  const ctx: CondContext = { dispatch, namespace, session, name }
  let result: boolean
  try {
    if (Array.isArray(args)) {
      result = await evalFlat(ctx, args)
    } else {
      result = await evalCond(ctx, args)
    }
  } catch (exc) {
    if (!(exc instanceof CondError)) throw exc
    const stderr = new TextEncoder().encode(exc.message + '\n')
    if (name === '[[') {
      // A bad [[ ]] operator is a bash PARSE error: the whole input
      // line dies, not just this command.
      throw new ExitSignal(2, stderr, null, 2)
    }
    return [
      null,
      new IOResult({ exitCode: 2, stderr }),
      new ExecutionNode({ command: 'test', exitCode: 2, stderr }),
    ]
  }
  const code = result ? 0 : 1
  return [
    null,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'test', exitCode: code }),
  ]
}
