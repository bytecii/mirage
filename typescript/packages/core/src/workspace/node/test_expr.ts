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

import type { EvaluationContext } from '../evaluation.ts'
import type { SessionView } from '../../view/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { CondNode } from '../executor/builtins/condition/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { ExecuteFn } from '../expand/types.ts'
import { expandChunks, expandNode } from '../expand/node.ts'
import { expandPattern } from '../expand/pattern.ts'
import { splitFields } from '../expand/fields.ts'
import { ifsValue } from '../expand/variable.ts'
import { unmarkGlobs } from '../../utils/glob_walk.ts'

const CONTAINER_TYPES = new Set<string>([
  NT.BINARY_EXPRESSION,
  NT.UNARY_EXPRESSION,
  NT.NEGATION_EXPRESSION,
  NT.PARENTHESIZED_EXPRESSION,
])
// `[` is a command, so every operator the grammar folds into the test
// reaches it as an operand word for test to judge (`=~` and `+` are refused
// there, not dropped); `&&` and `||` end the command in bash.
const FLAT_SKIP_TOKENS = new Set(['&&', '||'])
const COND_OP_TOKENS = new Set(['=', '==', '!=', '=~', '<', '>', '&&', '||'])

/**
 * Expand a test_command `[ ... ]` into flat argv, tokens in source order.
 *
 * tree-sitter nests `-a`/`-o` chains unpredictably, so the shape is
 * discarded: every operator token and expanded operand is re-serialized
 * and the flat bash arity rules take over. Unquoted expansions
 * word-split like bash (an empty one drops out of argv).
 */
export async function expandTestExpr(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<string[]> {
  const result: string[] = []
  await flatten(node, result, context, executeFn, cs, view)
  return result
}

/**
 * Append the flat tokens of one test-expression node to `out`. Returns
 * false when a statement separator surfaced inside an ERROR recovery
 * node — tree-sitter swallowed the rest of the line into the test, so
 * everything after the break point is discarded.
 */
async function flatten(
  node: TSNodeLike,
  out: string[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<boolean> {
  const session = context.session
  for (const child of node.children) {
    const ctype = child.type
    if (ctype === '[' || ctype === ']' || ctype === '[[' || ctype === ']]') continue
    if (ctype === NT.ERROR) {
      if (child.children.some((g) => g.isNamed !== true && g.type === ';')) return false
      if (!(await flatten(child, out, context, executeFn, cs, view))) return false
      continue
    }
    if (child.isNamed !== true) {
      if (!FLAT_SKIP_TOKENS.has(ctype)) out.push(child.text)
      continue
    }
    if (CONTAINER_TYPES.has(ctype)) {
      const negative = negativeNumberChild(child)
      if (negative !== null) {
        out.push('-' + (await expandNode(negative, context, executeFn, cs, view)))
        continue
      }
      if (!(await flatten(child, out, context, executeFn, cs, view))) return false
      continue
    }
    if (ctype === NT.TEST_OPERATOR) {
      out.push(child.text)
      continue
    }
    const chunks = await expandChunks(child, context, executeFn, cs, view)
    for (const word of splitFields(chunks, ifsValue(session, cs))) out.push(unmarkGlobs(word))
  }
  return true
}

/**
 * Detect a unary_expression that is really a negative number word.
 * tree-sitter parses `-1` inside a test as unary_expression with a bare
 * `-` token; the flat argv needs it back as one operand.
 */
function negativeNumberChild(node: TSNodeLike): TSNodeLike | null {
  if (node.type !== NT.UNARY_EXPRESSION) return null
  const children = node.children
  const first = children[0]
  const second = children[1]
  if (
    children.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    first.isNamed !== true &&
    first.type === '-' &&
    second.isNamed === true &&
    second.type !== NT.TEST_OPERATOR
  ) {
    return second
  }
  return null
}

/**
 * Build a structured condition tree from a `[[ ... ]]` node.
 *
 * tree-sitter nests the expression by its own precedence (`=~` looser than
 * `||`, `!` tighter than `=~`), so its tokens are read again as bash parses
 * them; a shape that reading refuses keeps tree-sitter's tree.
 */
export async function expandDoubleBracket(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  const first = node.namedChildren[0]
  if (first === undefined) return { kind: 'word', value: '' }
  let tree: CondTree
  try {
    const tokens: CondToken[] = []
    condTokens(node, tokens)
    tree = new CondParser(tokens).parse()
  } catch (error) {
    if (!(error instanceof CondSyntax)) throw error
    console.debug(`[[ ]] keeps tree-sitter's reading: ${String(error)}`)
    return buildCond(first, context, executeFn, cs, view)
  }
  return condNode(tree, context, executeFn, cs, view)
}

/**
 * One token of a `[[ ]]` expression: an operator's text, or an operand node
 * (`negative` for a `-N` tree-sitter split into `-` and N).
 */
interface CondToken {
  readonly op: string | null
  readonly operand: TSNodeLike | null
  readonly negative: boolean
}

/** A parsed `[[ ]]` expression. */
type CondTree =
  | { kind: 'and' | 'or'; left: CondTree; right: CondTree }
  | { kind: 'not' | 'group'; inner: CondTree }
  | { kind: 'unary'; op: string; operand: CondToken }
  | { kind: 'binary'; op: string; left: CondToken; right: CondToken }
  | { kind: 'word'; operand: CondToken }

/** The tokens are no expression the `[[ ]]` grammar reads. */
class CondSyntax extends Error {}

const COND_BINARY_TOKENS = new Set(['=', '==', '!=', '=~', '<', '>'])

/** Append the tokens of a `[[ ]]` node to `out` in source order. */
function condTokens(node: TSNodeLike, out: CondToken[]): void {
  for (const child of node.children) {
    const ctype = child.type
    if (ctype === '[[' || ctype === ']]') continue
    if (ctype === NT.ERROR) throw new CondSyntax()
    if (child.isNamed !== true) {
      out.push({ op: ctype, operand: null, negative: false })
    } else if (ctype === NT.TEST_OPERATOR) {
      out.push({ op: child.text, operand: null, negative: false })
    } else if (CONTAINER_TYPES.has(ctype)) {
      const negative = negativeNumberChild(child)
      if (negative !== null) out.push({ op: null, operand: negative, negative: true })
      else condTokens(child, out)
    } else {
      out.push({ op: null, operand: child, negative: false })
    }
  }
}

/**
 * bash's `[[ ]]` grammar over the flat tokens, loosest first: `||`, `&&`,
 * then a term. A term is any run of `!` (each one toggles a single
 * inversion, so `! !` inverts nothing) before a parenthesized expression, a
 * unary test, a binary test or a word.
 */
class CondParser {
  private at = 0

  constructor(private readonly tokens: CondToken[]) {}

  private op(ahead = 0): string | null {
    return this.tokens[this.at + ahead]?.op ?? null
  }

  private operand(ahead = 0): boolean {
    return this.tokens[this.at + ahead]?.op === null
  }

  private take(): CondToken {
    const token = this.tokens[this.at]
    if (token === undefined) throw new CondSyntax()
    this.at++
    return token
  }

  parse(): CondTree {
    const tree = this.either()
    if (this.at !== this.tokens.length) throw new CondSyntax()
    return tree
  }

  private either(): CondTree {
    let tree = this.both()
    while (this.op() === '||') {
      this.at++
      tree = { kind: 'or', left: tree, right: this.both() }
    }
    return tree
  }

  private both(): CondTree {
    let tree = this.term()
    while (this.op() === '&&') {
      this.at++
      tree = { kind: 'and', left: tree, right: this.term() }
    }
    return tree
  }

  private term(): CondTree {
    let inverted = false
    while (this.op() === '!') {
      this.at++
      inverted = !inverted
    }
    let tree: CondTree
    if (this.op() === '(') {
      this.at++
      tree = { kind: 'group', inner: this.either() }
      if (this.op() !== ')') throw new CondSyntax()
      this.at++
    } else {
      tree = this.test()
    }
    return inverted ? { kind: 'not', inner: tree } : tree
  }

  private test(): CondTree {
    const op = this.op()
    if (op !== null && op.startsWith('-') && this.operand(1)) {
      this.at++
      return { kind: 'unary', op, operand: this.take() }
    }
    if (!this.operand()) throw new CondSyntax()
    const binary = this.op(1)
    if (
      binary !== null &&
      (COND_BINARY_TOKENS.has(binary) || binary.startsWith('-')) &&
      this.operand(2)
    ) {
      const left = this.take()
      this.at++
      return { kind: 'binary', op: binary, left, right: this.take() }
    }
    return { kind: 'word', operand: this.take() }
  }
}

/** Expand one parsed `[[ ]]` tree into a CondNode. */
async function condNode(
  tree: CondTree,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  switch (tree.kind) {
    case 'and':
    case 'or': {
      // Expansion is part of evaluating an operand, so skipped branches cannot
      // run substitutions or observe state before the left side.
      const { left, right } = tree
      const first: CondNode = {
        kind: 'lazy',
        expand: () => condNode(left, context, executeFn, cs, view),
      }
      const second: CondNode = {
        kind: 'lazy',
        expand: () => condNode(right, context, executeFn, cs, view),
      }
      return { kind: tree.kind, left: first, right: second }
    }
    case 'not':
      return { kind: 'not', inner: await condNode(tree.inner, context, executeFn, cs, view) }
    case 'group':
      return condNode(tree.inner, context, executeFn, cs, view)
    case 'unary':
      return {
        kind: 'unary',
        op: tree.op,
        operand: await tokenText(tree.operand, context, executeFn, cs, view),
      }
    case 'binary': {
      const leftText = await tokenText(tree.left, context, executeFn, cs, view)
      const right = tree.right
      if (right.negative || right.operand === null) {
        const rightText = await tokenText(right, context, executeFn, cs, view)
        return {
          kind: 'binary',
          left: leftText,
          op: tree.op,
          right: rightText,
          rightLiteral: false,
        }
      }
      return comparison(tree.op, leftText, right.operand, context, executeFn, cs, view)
    }
    case 'word':
      return { kind: 'word', value: await tokenText(tree.operand, context, executeFn, cs, view) }
  }
}

async function tokenText(
  token: CondToken,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<string> {
  if (token.operand === null) return ''
  const text = await expandNode(token.operand, context, executeFn, cs, view)
  return token.negative ? '-' + text : text
}

/** Recursively translate one expression node into a CondNode. */
async function buildCond(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  const ntype = node.type
  if (ntype === NT.PARENTHESIZED_EXPRESSION) {
    const inner = node.namedChildren[0]
    if (inner === undefined) return { kind: 'word', value: '' }
    return buildCond(inner, context, executeFn, cs, view)
  }
  if (ntype === NT.UNARY_EXPRESSION || ntype === NT.NEGATION_EXPRESSION) {
    return buildUnary(node, context, executeFn, cs, view)
  }
  if (ntype === NT.BINARY_EXPRESSION) {
    return buildBinary(node, context, executeFn, cs, view)
  }
  return { kind: 'word', value: await expandNode(node, context, executeFn, cs, view) }
}

/** Translate a unary/negation expression node. */
async function buildUnary(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  const negated = node.children.some((c) => c.type === '!')
  let op: string | null = null
  let operandNode: TSNodeLike | null = null
  for (const child of node.children) {
    if (child.type === NT.TEST_OPERATOR) {
      op = child.text
    } else if (child.isNamed === true) {
      operandNode = child
    }
  }
  if (op === null && operandNode !== null && negated) {
    return { kind: 'not', inner: await buildCond(operandNode, context, executeFn, cs, view) }
  }
  if (op === null) {
    const value =
      operandNode === null ? '' : await expandNode(operandNode, context, executeFn, cs, view)
    const word: CondNode = { kind: 'word', value }
    return negated ? { kind: 'not', inner: word } : word
  }
  const operand =
    operandNode === null ? '' : await expandNode(operandNode, context, executeFn, cs, view)
  const unary: CondNode = { kind: 'unary', op, operand }
  return negated ? { kind: 'not', inner: unary } : unary
}

/** Translate a binary expression node (logical or comparison). */
async function buildBinary(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  let op: string | null = null
  const operands: TSNodeLike[] = []
  for (const child of node.children) {
    if (child.isNamed !== true) {
      if (COND_OP_TOKENS.has(child.type)) op = child.type
      continue
    }
    if (child.type === NT.TEST_OPERATOR && op === null && operands.length > 0) {
      op = child.text
      continue
    }
    operands.push(child)
  }
  const left = operands[0]
  const right = operands[1]
  if ((op === '&&' || op === '||') && left !== undefined && right !== undefined) {
    // Expansion is part of evaluating an operand, so skipped branches cannot
    // run substitutions or observe state before the left side.
    const leftCond: CondNode = {
      kind: 'lazy',
      expand: () => buildCond(left, context, executeFn, cs, view),
    }
    const rightCond: CondNode = {
      kind: 'lazy',
      expand: () => buildCond(right, context, executeFn, cs, view),
    }
    return op === '&&'
      ? { kind: 'and', left: leftCond, right: rightCond }
      : { kind: 'or', left: leftCond, right: rightCond }
  }
  if (op === null || left === undefined || right === undefined) {
    const textParts: string[] = []
    for (const operand of operands) {
      textParts.push(await expandNode(operand, context, executeFn, cs, view))
    }
    return { kind: 'word', value: textParts.join(' ') }
  }
  const leftText = await expandNode(left, context, executeFn, cs, view)
  return comparison(op, leftText, right, context, executeFn, cs, view)
}

/** A binary test, its right operand expanded as `op` reads it. */
async function comparison(
  op: string,
  leftText: string,
  right: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  if (op === '=~' && right.type === NT.REGEX) {
    const raw = right.text
    // After =~ tree-sitter lexes even a quoted operand as one regex
    // token; quoted means bash matches it literally.
    const singleQuoted = raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")
    const doubleQuoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
    if (singleQuoted || doubleQuoted) {
      return { kind: 'binary', left: leftText, op, right: raw.slice(1, -1), rightLiteral: true }
    }
    return { kind: 'binary', left: leftText, op, right: raw, rightLiteral: false }
  }
  if (op === '=' || op === '==' || op === '!=') {
    // The right side of a glob comparison is a pattern word; the shared
    // expander renders its quoting into the matcher's dialect per
    // segment (quoted literal, unquoted globs live), so the evaluator
    // fnmatches unconditionally. A wholly-literal pattern matches
    // exactly itself, which is what the equality the old whole-node
    // boolean spelled out reduced to.
    const pattern = await expandPattern(right, context, executeFn, cs, view)
    return { kind: 'binary', left: leftText, op, right: pattern, rightLiteral: false }
  }
  const rightText = await expandNode(right, context, executeFn, cs, view)
  return { kind: 'binary', left: leftText, op, right: rightText, rightLiteral: false }
}
