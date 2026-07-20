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

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Union

from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.shell.arith import ArithError, evaluate_arith
from mirage.shell.errors import ExitSignal
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.path import resolve_path, resolve_symlinks
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

CondNode = Union["CondWord", "CondUnary", "CondBinary", "CondNot", "CondAnd",
                 "CondOr"]


@dataclass(frozen=True, slots=True)
class CondWord:
    value: str


@dataclass(frozen=True, slots=True)
class CondUnary:
    op: str
    operand: str


@dataclass(frozen=True, slots=True)
class CondBinary:
    left: str
    op: str
    right: str
    # True when the right side was quoted: `[[ x == "a*" ]]` compares
    # literally while the unquoted form pattern-matches.
    right_literal: bool = False


@dataclass(frozen=True, slots=True)
class CondNot:
    inner: CondNode


@dataclass(frozen=True, slots=True)
class CondAnd:
    left: CondNode
    right: CondNode


@dataclass(frozen=True, slots=True)
class CondOr:
    left: CondNode
    right: CondNode


class CondError(Exception):
    """A test/[/[[ usage error: bash prints the message and returns 2.

    Args:
        message (str): diagnostic without trailing newline.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True, slots=True)
class CondContext:
    dispatch: Callable[..., Any]
    namespace: Namespace
    session: Session
    name: str


_STRING_BINARY = frozenset({"=", "==", "!="})
_NUMERIC_BINARY = frozenset({"-eq", "-ne", "-lt", "-le", "-gt", "-ge"})
_FILE_PAIR_BINARY = frozenset({"-nt", "-ot", "-ef"})
_STRING_UNARY = frozenset({"-n", "-z"})
_FILE_UNARY = frozenset({"-e", "-f", "-d", "-s", "-r", "-w", "-x", "-L", "-h"})
# Real GNU operators mirage cannot answer (no pipe/socket/tty/owner model);
# failing loudly beats the silent-false this module used to produce.
_UNSUPPORTED_UNARY = frozenset(
    {"-p", "-S", "-b", "-c", "-g", "-k", "-u", "-O", "-G", "-N", "-t"})
_BINARY_OPS = _STRING_BINARY | _NUMERIC_BINARY | _FILE_PAIR_BINARY
_UNARY_OPS = _STRING_UNARY | _FILE_UNARY | _UNSUPPORTED_UNARY


def _operand_scope(ctx: CondContext, val: str | PathSpec) -> PathSpec:
    """Resolve a file operand to an addressable scope.

    Args:
        ctx (CondContext): evaluation context.
        val (str | PathSpec): operand as typed or classified.
    """
    if isinstance(val, PathSpec):
        return val
    resolved = resolve_path(val, ctx.session.cwd)
    resolved = resolve_symlinks(resolved, ctx.namespace.symlink_targets())
    return _to_scope(resolved)


async def _path_kind(
        ctx: CondContext,
        val: str | PathSpec) -> tuple[str | None, FileStat | None]:
    """Resolve an operand to 'dir' / 'file' / None plus its stat.

    Symlinks are followed first (test -e/-f/-d act on the target); a
    stat that names a directory type answers directly, otherwise a
    readdir probe catches backends whose stat cannot see directories.
    The probe demands a non-empty listing: prefix stores (s3, gridfs,
    hf, nextcloud) list a missing path as [] instead of raising, and
    they cannot hold an empty directory anyway.

    Args:
        ctx (CondContext): evaluation context.
        val (str | PathSpec): operand as typed or classified.
    """
    scope = _operand_scope(ctx, val)
    try:
        stat, _ = await ctx.dispatch("stat", scope)
    except (FileNotFoundError, ValueError, NotADirectoryError):
        stat = None
    if stat is not None:
        if stat.type == FileType.DIRECTORY:
            return "dir", stat
        return "file", stat
    try:
        entries, _ = await ctx.dispatch("readdir", scope)
    except (FileNotFoundError, ValueError, NotADirectoryError):
        return None, None
    if entries:
        return "dir", None
    return None, None


async def _apply_unary(ctx: CondContext, op: str, val: str | PathSpec) -> bool:
    """Evaluate a unary operator.

    Args:
        ctx (CondContext): evaluation context.
        op (str): operator token, e.g. ``-n`` or ``-e``.
        val (str | PathSpec): operand.
    """
    text = _scope_path(val)
    if op == "-n":
        return text != ""
    if op == "-z":
        return text == ""
    if op in ("-L", "-h"):
        resolved = resolve_path(text, ctx.session.cwd)
        return ctx.namespace.is_link(resolved)
    if op in _FILE_UNARY:
        if not isinstance(val, PathSpec) and not text:
            return False
        kind, stat = await _path_kind(ctx, val)
        if op == "-e":
            return kind is not None
        if op == "-f":
            return kind == "file"
        if op == "-d":
            return kind == "dir"
        if op == "-s":
            if kind == "dir":
                return True
            if kind != "file" or stat is None:
                return False
            if stat.size is not None:
                return stat.size > 0
            # API backends (dropbox, gdrive, box) stat freshly written
            # empty files as size-unknown; only a read can answer, and
            # the prefetch TTL cache keeps repeat tests cheap.
            data, _ = await ctx.dispatch("read", _operand_scope(ctx, val))
            return len(await materialize(data)) > 0
        if op in ("-r", "-w"):
            # Mirage has no per-user access model: whatever exists in a
            # mount is readable and writable through it.
            return kind is not None
        if op == "-x":
            if kind == "dir":
                return True
            if kind != "file" or stat is None:
                return False
            return stat.mode is not None and bool(stat.mode & 0o111)
    if op in _UNSUPPORTED_UNARY:
        raise CondError(f"{ctx.name}: {op}: unsupported operator")
    raise CondError(f"{ctx.name}: {op}: unary operator expected")


def _to_int(ctx: CondContext, text: str) -> int:
    """Parse a test integer operand, with bash's diagnostic.

    Args:
        ctx (CondContext): evaluation context.
        text (str): operand text.
    """
    try:
        return int(text.strip())
    except ValueError:
        raise CondError(f"{ctx.name}: {text}: integer expression expected")


async def _apply_binary(ctx: CondContext, left: str | PathSpec, op: str,
                        right: str | PathSpec) -> bool:
    """Evaluate a test/[ binary operator (literal string semantics).

    Args:
        ctx (CondContext): evaluation context.
        left (str | PathSpec): left operand.
        op (str): operator token.
        right (str | PathSpec): right operand.
    """
    lt = _scope_path(left)
    rt = _scope_path(right)
    if op in ("=", "=="):
        return lt == rt
    if op == "!=":
        return lt != rt
    if op in _NUMERIC_BINARY:
        li = _to_int(ctx, lt)
        ri = _to_int(ctx, rt)
        return _compare_ints(op, li, ri)
    if op in _FILE_PAIR_BINARY:
        raise CondError(f"{ctx.name}: {op}: unsupported operator")
    raise CondError(f"{ctx.name}: {op}: binary operator expected")


def _compare_ints(op: str, li: int, ri: int) -> bool:
    """Apply a numeric comparison operator.

    Args:
        op (str): one of -eq -ne -lt -le -gt -ge.
        li (int): left value.
        ri (int): right value.
    """
    if op == "-eq":
        return li == ri
    if op == "-ne":
        return li != ri
    if op == "-lt":
        return li < ri
    if op == "-le":
        return li <= ri
    if op == "-gt":
        return li > ri
    return li >= ri


async def _eval_one(ctx: CondContext, arg: str | PathSpec) -> bool:
    """One-argument rule: true when the operand is non-empty.

    Args:
        ctx (CondContext): evaluation context.
        arg (str | PathSpec): sole operand.
    """
    return _scope_path(arg) != ""


async def _eval_two(ctx: CondContext, argv: list[str | PathSpec]) -> bool:
    """Two-argument rule: ``!`` or a unary operator.

    Args:
        ctx (CondContext): evaluation context.
        argv (list[str | PathSpec]): exactly two operands.
    """
    first = _scope_path(argv[0])
    if first == "!":
        return not await _eval_one(ctx, argv[1])
    if first in _UNARY_OPS:
        return await _apply_unary(ctx, first, argv[1])
    raise CondError(f"{ctx.name}: {first}: unary operator expected")


async def _eval_three(ctx: CondContext, argv: list[str | PathSpec]) -> bool:
    """Three-argument rule: binary op, ``-a``/``-o``, ``!``, or parens.

    Args:
        ctx (CondContext): evaluation context.
        argv (list[str | PathSpec]): exactly three operands.
    """
    mid = _scope_path(argv[1])
    if mid == "-a":
        return await _eval_one(ctx, argv[0]) and await _eval_one(ctx, argv[2])
    if mid == "-o":
        return await _eval_one(ctx, argv[0]) or await _eval_one(ctx, argv[2])
    if mid in _BINARY_OPS:
        return await _apply_binary(ctx, argv[0], mid, argv[2])
    first = _scope_path(argv[0])
    if first == "!":
        return not await _eval_two(ctx, argv[1:])
    if first == "(" and _scope_path(argv[2]) == ")":
        return await _eval_one(ctx, argv[1])
    raise CondError(f"{ctx.name}: {mid}: binary operator expected")


async def _eval_four(ctx: CondContext, argv: list[str | PathSpec]) -> bool:
    """Four-argument rule: leading ``!`` or parens, else expr parser.

    Args:
        ctx (CondContext): evaluation context.
        argv (list[str | PathSpec]): exactly four operands.
    """
    first = _scope_path(argv[0])
    if first == "!":
        return not await _eval_three(ctx, argv[1:])
    if first == "(" and _scope_path(argv[3]) == ")":
        return await _eval_two(ctx, argv[1:3])
    parser = _ExprParser(ctx, argv)
    return await parser.run()


class _ExprParser:
    """Recursive-descent ``test`` expression parser (>4 args, GNU expr
    grammar: or -> and -> term with ``!`` and parentheses)."""

    def __init__(self, ctx: CondContext, argv: list[str | PathSpec]) -> None:
        self.ctx = ctx
        self.argv = argv
        self.pos = 0

    def _peek(self, offset: int = 0) -> str | None:
        i = self.pos + offset
        if i < len(self.argv):
            return _scope_path(self.argv[i])
        return None

    async def run(self) -> bool:
        result = await self._or_expr()
        if self.pos != len(self.argv):
            raise CondError(f"{self.ctx.name}: too many arguments")
        return result

    async def _or_expr(self) -> bool:
        result = await self._and_expr()
        while self._peek() == "-o":
            self.pos += 1
            right = await self._and_expr()
            result = result or right
        return result

    async def _and_expr(self) -> bool:
        result = await self._term()
        while self._peek() == "-a":
            self.pos += 1
            right = await self._term()
            result = result and right
        return result

    async def _term(self) -> bool:
        tok = self._peek()
        if tok is None:
            raise CondError(f"{self.ctx.name}: argument expected")
        if tok == "!":
            self.pos += 1
            return not await self._term()
        if tok == "(":
            self.pos += 1
            result = await self._or_expr()
            if self._peek() != ")":
                raise CondError(f"{self.ctx.name}: `)' expected")
            self.pos += 1
            return result
        nxt = self._peek(1)
        if nxt in _BINARY_OPS and self._peek(2) is not None:
            left = self.argv[self.pos]
            right = self.argv[self.pos + 2]
            self.pos += 3
            return await _apply_binary(self.ctx, left, nxt, right)
        if tok in _UNARY_OPS and nxt is not None and nxt not in ("-a", "-o"):
            operand = self.argv[self.pos + 1]
            self.pos += 2
            return await _apply_unary(self.ctx, tok, operand)
        self.pos += 1
        return tok != ""


async def eval_flat(ctx: CondContext, argv: list[str | PathSpec]) -> bool:
    """Evaluate a flat ``test``/``[`` argument list with bash's arity
    rules.

    Args:
        ctx (CondContext): evaluation context.
        argv (list[str | PathSpec]): operands, brackets excluded.
    """
    n = len(argv)
    if n == 0:
        return False
    if n == 1:
        return await _eval_one(ctx, argv[0])
    if n == 2:
        return await _eval_two(ctx, argv)
    if n == 3:
        return await _eval_three(ctx, argv)
    if n == 4:
        return await _eval_four(ctx, argv)
    parser = _ExprParser(ctx, argv)
    return await parser.run()


async def eval_cond(ctx: CondContext, node: CondNode) -> bool:
    """Evaluate a structured ``[[ ]]`` expression tree.

    Args:
        ctx (CondContext): evaluation context.
        node (CondNode): parsed condition.
    """
    if isinstance(node, CondAnd):
        return (await eval_cond(ctx, node.left)
                and await eval_cond(ctx, node.right))
    if isinstance(node, CondOr):
        return (await eval_cond(ctx, node.left)
                or await eval_cond(ctx, node.right))
    if isinstance(node, CondNot):
        return not await eval_cond(ctx, node.inner)
    if isinstance(node, CondUnary):
        if node.op not in _UNARY_OPS:
            raise CondError("mirage: conditional unary operator expected")
        return await _apply_unary(ctx, node.op, node.operand)
    if isinstance(node, CondBinary):
        return await _eval_cond_binary(ctx, node)
    return node.value != ""


async def _eval_cond_binary(ctx: CondContext, node: CondBinary) -> bool:
    """Evaluate a ``[[ ]]`` binary: pattern/regex/string/arith semantics.

    Args:
        ctx (CondContext): evaluation context.
        node (CondBinary): binary condition.
    """
    if node.op in ("=", "=="):
        if node.right_literal:
            return node.left == node.right
        return fnmatch(node.left, node.right)
    if node.op == "!=":
        if node.right_literal:
            return node.left != node.right
        return not fnmatch(node.left, node.right)
    if node.op == "=~":
        pattern = re.escape(node.right) if node.right_literal else node.right
        try:
            match = re.search(pattern, node.left)
        except re.error:
            raise CondError("mirage: syntax error in conditional expression")
        if match is None:
            return False
        groups = [g if g is not None else "" for g in match.groups()]
        ctx.session.arrays["BASH_REMATCH"] = [match.group(0), *groups]
        return True
    if node.op == "<":
        return node.left < node.right
    if node.op == ">":
        return node.left > node.right
    if node.op in _NUMERIC_BINARY:
        # [[ evaluates numeric operands as arithmetic: variables
        # resolve, expressions compute, bare unset words are 0.
        try:
            li, _ = evaluate_arith(node.left, ctx.session.env)
            ri, _ = evaluate_arith(node.right, ctx.session.env)
        except ArithError:
            raise CondError("mirage: syntax error in conditional expression")
        return _compare_ints(node.op, li, ri)
    if node.op in _FILE_PAIR_BINARY:
        raise CondError(f"{ctx.name}: {node.op}: unsupported operator")
    raise CondError("mirage: conditional binary operator expected")


async def handle_test(
    dispatch: Callable[..., Any],
    namespace: Namespace,
    args: list[str | PathSpec] | CondNode,
    session: Session,
    name: str = "test",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Evaluate test/[ (flat argv) or [[ (condition tree).

    Args:
        dispatch (Callable): op dispatcher for file probes.
        namespace (Namespace): addressing authority (symlink table).
        args (list[str | PathSpec] | CondNode): flat operands for
            test/[, a CondNode tree for [[.
        session (Session): session for cwd, env, and BASH_REMATCH.
        name (str): invocation name for diagnostics: "test", "[", "[[".
    """
    ctx = CondContext(dispatch=dispatch,
                      namespace=namespace,
                      session=session,
                      name=name)
    try:
        if isinstance(args, list):
            result = await eval_flat(ctx, args)
        else:
            result = await eval_cond(ctx, args)
    except CondError as err:
        stderr = (err.message + "\n").encode()
        if name == "[[":
            # A bad [[ ]] operator is a bash PARSE error: the whole
            # input line dies, not just this command.
            raise ExitSignal(2, stderr=stderr, contained_code=2)
        return None, IOResult(exit_code=2,
                              stderr=stderr), ExecutionNode(command="test",
                                                            exit_code=2,
                                                            stderr=stderr)
    code = 0 if result else 1
    return None, IOResult(exit_code=code), ExecutionNode(command="test",
                                                         exit_code=code)
