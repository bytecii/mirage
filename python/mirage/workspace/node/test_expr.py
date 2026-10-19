# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import logging
from dataclasses import dataclass
from functools import partial
from typing import Any

from mirage.shell.bytes import decode_text
from mirage.shell.types import NodeType as NT
from mirage.types import PathSpec
from mirage.utils.glob_walk import unmark_globs
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.condition.types import (
    CondAnd,
    CondBinary,
    CondLazy,
    CondNode,
    CondNot,
    CondOr,
    CondUnary,
    CondWord,
)
from mirage.workspace.expand import expand_node
from mirage.workspace.expand.fields import split_fields
from mirage.workspace.expand.node import expand_chunks
from mirage.workspace.expand.pattern import expand_pattern
from mirage.workspace.expand.variable import ifs_value

logger = logging.getLogger(__name__)

_CONTAINER_TYPES = (
    NT.BINARY_EXPRESSION,
    NT.UNARY_EXPRESSION,
    NT.NEGATION_EXPRESSION,
    NT.PARENTHESIZED_EXPRESSION,
)
# `[` is a command, so every operator the grammar folds into the test
# reaches it as an operand word for test to judge (`=~` and `+` are
# refused there, not dropped); `&&` and `||` end the command in bash.
_FLAT_SKIP_TOKENS = frozenset({"&&", "||"})
_COND_OP_TOKENS = frozenset({"=", "==", "!=", "=~", "<", ">", "&&", "||"})


async def expand_test_expr(
    node,
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None = None,
) -> list[str | PathSpec]:
    """Expand a test_command ``[ ... ]`` into flat argv, tokens in
    source order.

    tree-sitter nests ``-a``/``-o`` chains unpredictably, so the shape
    is discarded: every operator token and expanded operand is
    re-serialized and the flat bash arity rules take over. Unquoted
    expansions word-split like bash (an empty one drops out of argv).

    Args:
        node: tree-sitter test_command node.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    result: list[str | PathSpec] = []
    await _flatten(node, result, context, execute_fn, cs, view=view)
    return result


async def _flatten(
    node,
    out: list[str | PathSpec],
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None = None,
) -> bool:
    """Append the flat tokens of one test-expression node to ``out``.

    Returns False when a statement separator surfaced inside an ERROR
    recovery node — tree-sitter swallowed the rest of the line into the
    test, so everything after the break point is discarded.

    Args:
        node: tree-sitter node to serialize.
        out (list[str]): accumulator.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    session = context.session
    for child in node.children:
        ctype = child.type
        if ctype in ("[", "]", "[[", "]]"):
            continue
        if ctype == NT.ERROR:
            if any(not g.is_named and g.type == ";" for g in child.children):
                return False
            if not await _flatten(
                child, out, context, execute_fn, cs, view=view
            ):
                return False
            continue
        if not child.is_named:
            if ctype not in _FLAT_SKIP_TOKENS:
                out.append(decode_text(child.text))
            continue
        if ctype in _CONTAINER_TYPES:
            negative = _negative_number_child(child)
            if negative is not None:
                expanded = await expand_node(
                    negative, context, execute_fn, cs, view=view
                )
                out.append("-" + expanded)
                continue
            if not await _flatten(
                child, out, context, execute_fn, cs, view=view
            ):
                return False
            continue
        if ctype == NT.TEST_OPERATOR:
            out.append(decode_text(child.text))
            continue
        chunks = await expand_chunks(child, context, execute_fn, cs, view=view)
        out.extend(
            unmark_globs(word)
            for word in split_fields(chunks, ifs_value(session, cs))
        )
    return True


def _negative_number_child(node):
    """Detect a unary_expression that is really a negative number word.

    tree-sitter parses ``-1`` inside a test as unary_expression with a
    bare ``-`` token; the flat argv needs it back as one operand.

    Args:
        node: tree-sitter container node.
    """
    if node.type != NT.UNARY_EXPRESSION:
        return None
    children = list(node.children)
    if (
        len(children) == 2
        and not children[0].is_named
        and children[0].type == "-"
        and children[1].is_named
        and children[1].type != NT.TEST_OPERATOR
    ):
        return children[1]
    return None


async def expand_double_bracket(
    node,
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None = None,
) -> CondNode:
    """Build a structured condition tree from a ``[[ ... ]]`` node.

    tree-sitter nests the expression by its own precedence (``=~``
    looser than ``||``, ``!`` tighter than ``=~``), so its tokens are
    read again as bash parses them; a shape that reading refuses keeps
    tree-sitter's tree.

    Args:
        node: tree-sitter test_command node opened with ``[[``.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    exprs = [c for c in node.named_children]
    if not exprs:
        return CondWord("")
    tokens: list[_CondToken] = []
    try:
        _cond_tokens(node, tokens)
        tree = _CondParser(tokens).parse()
    except _CondSyntax as exc:
        logger.debug("[[ ]] keeps tree-sitter's reading: %s", exc)
        return await _build_cond(exprs[0], context, execute_fn, cs, view=view)
    return await _cond_node(tree, context, execute_fn, cs, view)


# One token of a ``[[ ]]`` expression: an operator's text, or an operand
# node (``negative`` for a ``-N`` tree-sitter split into ``-`` and N).
@dataclass(frozen=True, slots=True)
class _CondToken:
    op: str | None = None
    operand: Any = None
    negative: bool = False


# A parsed ``[[ ]]`` expression: its kind, then its parts.
_CondTree = tuple[Any, ...]


class _CondSyntax(Exception):
    """The tokens are no expression the ``[[ ]]`` grammar reads."""


def _cond_tokens(node, out: list[_CondToken]) -> None:
    """Append the tokens of a ``[[ ]]`` node to ``out`` in source order.

    Args:
        node: tree-sitter node to flatten.
        out (list[_CondToken]): accumulator.
    """
    for child in node.children:
        ctype = child.type
        if ctype in ("[[", "]]"):
            continue
        if ctype == NT.ERROR:
            raise _CondSyntax
        if not child.is_named:
            out.append(_CondToken(op=ctype))
        elif ctype == NT.TEST_OPERATOR:
            out.append(_CondToken(op=decode_text(child.text)))
        elif ctype in _CONTAINER_TYPES:
            negative = _negative_number_child(child)
            if negative is not None:
                out.append(_CondToken(operand=negative, negative=True))
            else:
                _cond_tokens(child, out)
        else:
            out.append(_CondToken(operand=child))


class _CondParser:
    """bash's ``[[ ]]`` grammar over the flat tokens, loosest first:
    ``||``, ``&&``, then a term. A term is any run of ``!`` (each one
    toggles a single inversion, so ``! !`` inverts nothing) before a
    parenthesized expression, a unary test, a binary test or a word.
    The tree is tuples, expanded later by ``_cond_node``.
    """

    def __init__(self, tokens: list[_CondToken]) -> None:
        self.tokens = tokens
        self.at = 0

    def _op(self, ahead: int = 0) -> str | None:
        at = self.at + ahead
        return self.tokens[at].op if at < len(self.tokens) else None

    def _operand(self, ahead: int = 0) -> bool:
        at = self.at + ahead
        return at < len(self.tokens) and self.tokens[at].op is None

    def parse(self) -> _CondTree:
        tree = self._either()
        if self.at != len(self.tokens):
            raise _CondSyntax
        return tree

    def _either(self) -> _CondTree:
        tree = self._both()
        while self._op() == "||":
            self.at += 1
            tree = ("or", tree, self._both())
        return tree

    def _both(self) -> _CondTree:
        tree = self._term()
        while self._op() == "&&":
            self.at += 1
            tree = ("and", tree, self._term())
        return tree

    def _term(self) -> _CondTree:
        inverted = False
        while self._op() == "!":
            self.at += 1
            inverted = not inverted
        if self._op() == "(":
            self.at += 1
            tree: _CondTree = ("group", self._either())
            if self._op() != ")":
                raise _CondSyntax
            self.at += 1
        else:
            tree = self._test()
        return ("not", tree) if inverted else tree

    def _test(self) -> _CondTree:
        op = self._op()
        if op is not None and op.startswith("-") and self._operand(1):
            self.at += 2
            return ("unary", op, self.tokens[self.at - 1])
        if not self._operand():
            raise _CondSyntax
        left = self.tokens[self.at]
        op = self._op(1)
        if (
            op is not None
            and (op in _COND_BINARY_TOKENS or op.startswith("-"))
            and self._operand(2)
        ):
            self.at += 3
            return ("binary", op, left, self.tokens[self.at - 1])
        self.at += 1
        return ("word", left)


_COND_BINARY_TOKENS = frozenset({"=", "==", "!=", "=~", "<", ">"})


async def _cond_node(
    tree: _CondTree,
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None,
) -> CondNode:
    """Expand one parsed ``[[ ]]`` tree into a CondNode.

    Args:
        tree (_CondTree): from ``_CondParser``.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    kind = tree[0]
    if kind in ("and", "or"):
        # Expansion is part of evaluating an operand, so skipped branches
        # cannot run substitutions or observe state before the left side.
        first = CondLazy(
            partial(_cond_node, tree[1], context, execute_fn, cs, view)
        )
        second = CondLazy(
            partial(_cond_node, tree[2], context, execute_fn, cs, view)
        )
        if kind == "and":
            return CondAnd(first, second)
        return CondOr(first, second)
    if kind == "not":
        return CondNot(
            await _cond_node(tree[1], context, execute_fn, cs, view)
        )
    if kind == "group":
        return await _cond_node(tree[1], context, execute_fn, cs, view)
    if kind == "unary":
        operand = await _token_text(tree[2], context, execute_fn, cs, view)
        return CondUnary(op=tree[1], operand=operand)
    if kind == "binary":
        left_text = await _token_text(tree[2], context, execute_fn, cs, view)
        right: _CondToken = tree[3]
        if right.negative:
            right_text = await _token_text(
                right, context, execute_fn, cs, view
            )
            return CondBinary(left=left_text, op=tree[1], right=right_text)
        return await _comparison(
            tree[1], left_text, right.operand, context, execute_fn, cs, view
        )
    return CondWord(await _token_text(tree[1], context, execute_fn, cs, view))


async def _token_text(
    token: _CondToken,
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None,
) -> str:
    text = await expand_node(token.operand, context, execute_fn, cs, view=view)
    return "-" + text if token.negative else text


async def _build_cond(
    node,
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None = None,
) -> CondNode:
    """Recursively translate one expression node into a CondNode.

    Args:
        node: tree-sitter expression node.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    ntype = node.type
    if ntype == NT.PARENTHESIZED_EXPRESSION:
        inner = [c for c in node.named_children]
        if not inner:
            return CondWord("")
        return await _build_cond(inner[0], context, execute_fn, cs, view=view)
    if ntype in (NT.UNARY_EXPRESSION, NT.NEGATION_EXPRESSION):
        return await _build_unary(node, context, execute_fn, cs, view=view)
    if ntype == NT.BINARY_EXPRESSION:
        return await _build_binary(node, context, execute_fn, cs, view=view)
    value = await expand_node(node, context, execute_fn, cs, view=view)
    return CondWord(value)


async def _build_unary(
    node,
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None = None,
) -> CondNode:
    """Translate a unary/negation expression node.

    Args:
        node: tree-sitter unary_expression or negation_expression.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    negated = any(c.type == "!" for c in node.children)
    op = None
    operand_node = None
    for child in node.children:
        if child.type == NT.TEST_OPERATOR:
            op = decode_text(child.text)
        elif child.is_named:
            operand_node = child
    if op is None and operand_node is not None and negated:
        inner = await _build_cond(
            operand_node, context, execute_fn, cs, view=view
        )
        return CondNot(inner)
    if op is None:
        value = ""
        if operand_node is not None:
            value = await expand_node(
                operand_node, context, execute_fn, cs, view=view
            )
        result: CondNode = CondWord(value)
        return CondNot(result) if negated else result
    operand = ""
    if operand_node is not None:
        operand = await expand_node(
            operand_node, context, execute_fn, cs, view=view
        )
    unary: CondNode = CondUnary(op=op, operand=operand)
    return CondNot(unary) if negated else unary


async def _build_binary(
    node,
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None = None,
) -> CondNode:
    """Translate a binary expression node (logical or comparison).

    Args:
        node: tree-sitter binary_expression.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    op = None
    operands: list[Any] = []
    for child in node.children:
        if not child.is_named:
            if child.type in _COND_OP_TOKENS:
                op = child.type
            continue
        if child.type == NT.TEST_OPERATOR and op is None and operands:
            op = decode_text(child.text)
            continue
        operands.append(child)
    if op in ("&&", "||") and len(operands) == 2:
        # Expansion is part of evaluating an operand, so skipped branches
        # cannot run substitutions or observe state before the left side.
        left = CondLazy(
            partial(
                _build_cond, operands[0], context, execute_fn, cs, view=view
            )
        )
        right = CondLazy(
            partial(
                _build_cond, operands[1], context, execute_fn, cs, view=view
            )
        )
        return CondAnd(left, right) if op == "&&" else CondOr(left, right)
    if op is None or len(operands) != 2:
        text_parts = []
        for operand in operands:
            text_parts.append(
                await expand_node(operand, context, execute_fn, cs, view=view)
            )
        return CondWord(" ".join(text_parts))
    left_text = await expand_node(
        operands[0], context, execute_fn, cs, view=view
    )
    return await _comparison(
        op, left_text, operands[1], context, execute_fn, cs, view
    )


async def _comparison(
    op: str,
    left_text: str,
    right_node,
    context: EvaluationContext,
    execute_fn,
    cs,
    view: SessionView | None,
) -> CondNode:
    """A binary test, its right operand expanded as ``op`` reads it.

    Args:
        op (str): the operator.
        left_text (str): the expanded left operand.
        right_node: the right operand's tree-sitter node.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    if op == "=~" and right_node.type == NT.REGEX:
        raw = decode_text(right_node.text)
        # After =~ tree-sitter lexes even a quoted operand as one regex
        # token; quoted means bash matches it literally.
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
            return CondBinary(
                left=left_text, op=op, right=raw[1:-1], right_literal=True
            )
        return CondBinary(
            left=left_text, op=op, right=raw, right_literal=False
        )
    if op in ("=", "==", "!="):
        # The right side of a glob comparison is a pattern word; the
        # shared expander renders its quoting into the matcher's
        # dialect per segment (quoted literal, unquoted globs live), so
        # the evaluator fnmatches unconditionally. A wholly-literal
        # pattern matches exactly itself, which is what the equality
        # the old whole-node boolean spelled out reduced to.
        pattern = await expand_pattern(
            right_node, context, execute_fn, cs, view=view
        )
        return CondBinary(
            left=left_text, op=op, right=pattern, right_literal=False
        )
    right_text = await expand_node(
        right_node, context, execute_fn, cs, view=view
    )
    return CondBinary(
        left=left_text, op=op, right=right_text, right_literal=False
    )
