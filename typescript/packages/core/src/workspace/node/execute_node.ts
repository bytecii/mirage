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

import { deref, seedVar } from '../session/state.ts'
import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import { makeAbortError } from '../abort.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { prependExitOutput, assignmentStatus, finishStatement } from '../executor/statement.ts'
import {
  getCaseItems,
  getCaseWord,
  getDeclarationKeyword,
  getCforParts,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getPipelineCommands,
  getRedirects,
  getText,
  getUnsetArgs,
  getWhileParts,
} from '../../shell/syntax/helpers.ts'
import { JobTable } from '../../shell/job_table/index.ts'
import { NodeType as NT } from '../../shell/types.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/constants.ts'
import { NodeKind, nodeKind } from '../../shell/syntax/node_kind.ts'
import { expandRedirects } from '../expand/redirects.ts'
import { expandArith, expandNode } from '../expand/node.ts'
import { expandPattern } from '../expand/pattern.ts'
import { evaluateArith } from '../../shell/arith.ts'
import {
  type ShellArray,
  arrayExtent,
  arrayGet,
  arraySet,
  buildAssocLiteral,
  buildIndexedLiteral,
} from '../../shell/array.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { ArithError, ExitSignal } from '../../shell/errors.ts'
import { expandAndClassify } from '../expand/parts.ts'
import { arrayIndex } from '../expand/variable.ts'
import { assignElement } from '../session/elements.ts'
import type { ArithResult, TSNodeLike } from '../../shell/types.ts'
import {
  type CforEval,
  handleCase,
  handleCfor,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
} from '../executor/control.ts'
import {
  handleExport,
  handleDeclareFunctions,
  handleDeclarePrint,
  handleLocal,
  handleReadonly,
  handleTest,
  handleUnset,
  noteLocalArray,
} from '../executor/builtins/index.ts'
import { handleConnection, handlePipe, handleSubshell } from '../executor/pipes.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { globOptions, resolveGlobs } from '../expand/globs.ts'
import { expandDoubleBracket, expandTestExpr } from './test_expr.ts'
import { executeProgram } from './program.ts'
import { installExecRedirects } from '../executor/builtins/exec_cmd.ts'
import { executeCommand } from './command_dispatch.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import {
  elementIndex,
  ensureVarVisible,
  sessionElements,
  sessionView,
  visibleEnv,
} from '../session/state.ts'
import { VarAttr } from '../../shell/variable.ts'
import { traceAssignment } from '../../shell/xtrace.ts'
import { Channel } from '../../shell/console/index.ts'
import { pump } from '../executor/jobs.ts'
import type {
  ExecuteNodeOpts,
  ExecutionResult as Result,
  ExecuteNodeDeps,
} from '../executor/types.ts'
import { STREAMING_KINDS } from './constants.ts'
import { assignVar, expandArrayItems, subscriptKeyText } from './assignment.ts'
import { evalCforExpr } from './arithmetic.ts'
import { recurseReassociated, recursePipeStderr } from './pipeline.ts'
import {
  attrsFor,
  mergeConversionErrors,
  declareOptionRefusal,
  plusRefusals,
  stampAttrs,
} from './declaration.ts'

/**
 * Layer per-call overrides onto the walker's deps.
 *
 * Written field by field rather than spread so an explicitly undefined
 * override cannot erase a dep under exactOptionalPropertyTypes.
 */
function withOpts(base: ExecuteNodeDeps, opts?: ExecuteNodeOpts): ExecuteNodeDeps {
  if (opts === undefined) return base
  const next: ExecuteNodeDeps = { ...base }
  if (opts.sink !== undefined) next.sink = opts.sink
  if (opts.signal !== undefined) next.signal = opts.signal
  return next
}

/**
 * Whether a redirected statement's command is a bare `exec`: a command
 * name and no arguments, so its redirects are the shell's own rather
 * than one command's. `exec cmd` is not bare and falls through to the
 * command path, which refuses it.
 */
function isBareExec(command: TSNodeLike | null): boolean {
  if (command?.type !== NT.COMMAND) return false
  const named = command.namedChildren
  return named.length === 1 && named[0]?.type === NT.COMMAND_NAME && getText(named[0]) === 'exec'
}

/** Collect substitution diagnostics once at their owning AST node. */
export async function executeNode(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const saved = session.cmdsubStderr
  session.cmdsubStderr = new Uint8Array()
  try {
    const [stdout, io, execution] = await walkNode(deps, node, session, stdin, callStack)
    if (session.cmdsubStderr.byteLength > 0) {
      io.stderr = concat([session.cmdsubStderr, await io.materializeStderr()])
      execution.stderr = io.stderr
    }
    return [stdout, io, execution]
  } catch (err) {
    if (err instanceof ExitSignal) err.stderr = concat([session.cmdsubStderr, err.stderr])
    throw err
  } finally {
    session.cmdsubStderr = saved
  }
}

async function walkNode(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const { sink, ...captureDeps } = deps
  const recurse = (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
    opts?: ExecuteNodeOpts,
  ): Promise<Result> => executeNode(withOpts(captureDeps, opts), n, s, i, cs)
  const stream =
    sink === undefined
      ? recurse
      : (
          n: TSNodeLike,
          s: Session,
          i: ByteSource | null,
          cs: CallStack | null,
          opts?: ExecuteNodeOpts,
        ): Promise<Result> => executeNode(withOpts(deps, opts), n, s, i, cs)

  const { dispatch, registry, jobTable, executeFn, agentId } = deps
  const kind = nodeKind(node)

  // `set -n` reads without executing, and it stops *everything* after
  // it, at every depth: GNU answers `if true; then set -n; echo BAD; fi`
  // and `f(){ set -n; echo BAD; }; f` with nothing at all. Stated here,
  // at the one door every node goes through, rather than in each
  // statement runner — the program loop, the subshell body, a group, a
  // function body and every loop body are five places for one rule to
  // drift, and it did: the check lived in the program loop alone, so
  // `set -n` worked flat and did nothing one construct deep. The program
  // loop keeps its own `break` as the reader-level stop, which is also
  // what silences `set -v` for the lines it never reads.
  if (session.shellOptions.noexec === true) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }
  if (deps.signal?.aborted === true || session.abortSignal?.aborted === true) {
    throw makeAbortError()
  }
  session.errexitImmune = false

  // A sink turns this walk from "return your output" into "write your
  // output". Sequencing constructs pass it to their children so each
  // statement lands as it finishes; everything else runs unchanged and
  // has its result drained here. Only STREAMING_KINDS inherit a sink,
  // so capture sites keep receiving their output as a value.
  if (sink !== undefined && !STREAMING_KINDS.has(kind)) {
    const [stdout, io, execNode] = await recurse(node, session, stdin, callStack)
    await pump(sink, Channel.STDOUT, stdout)
    const stderr = await io.materializeStderr()
    if (stderr.byteLength > 0) {
      await sink.emit(Channel.STDERR, stderr)
      // Cleared so the job's tail does not emit it a second time.
      io.stderr = null
    }
    return [null, io, execNode]
  }

  if (kind === NodeKind.COMMENT) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  if (kind === NodeKind.PROGRAM) {
    return executeProgram(
      stream,
      node,
      session,
      stdin,
      callStack,
      jobTable,
      agentId,
      dispatch,
      executeFn,
    )
  }

  if (kind === NodeKind.COMMAND) {
    return executeCommand(
      recurse,
      dispatch,
      registry,
      deps.namespace,
      executeFn,
      node,
      session,
      stdin,
      callStack,
      jobTable,
      deps.ensureOpen,
      deps.runtimeBindings,
      deps.routingDecision,
      deps.signal,
      deps.reparse,
    )
  }

  if (kind === NodeKind.PIPELINE) {
    const [pipeCommands, stderrFlags] = getPipelineCommands(node)
    let commands = pipeCommands
    // `! a | b` parses as pipeline(negated_command(a), b) but bash
    // negates the WHOLE pipeline's exit status.
    const first = commands[0]
    const negated = first?.type === NT.NEGATED_COMMAND
    if (negated) {
      commands = [getNegatedCommand(first), ...commands.slice(1)]
    }
    let pipeRecurse = recurse
    if (stderrFlags.some(Boolean)) {
      const targets = commands.filter((_, i) => stderrFlags[i] === true)
      pipeRecurse = recursePipeStderr.bind(null, recurse, dispatch, executeFn, registry, targets)
    }
    const [stdout, io, execNode] = await handlePipe(
      pipeRecurse,
      commands,
      stderrFlags,
      session,
      stdin,
      callStack,
      executeFn,
    )
    if (!negated) return [stdout, io, execNode]
    const flipped = new IOResult({
      exitCode: io.exitCode !== 0 ? 0 : 1,
      stderr: io.stderr,
      reads: io.reads,
      writes: io.writes,
      cache: io.cache,
    })
    execNode.exitCode = flipped.exitCode
    session.errexitImmune = true
    return [stdout, flipped, execNode]
  }

  if (kind === NodeKind.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnection(stream, left, op, right, session, stdin, callStack)
  }

  if (kind === NodeKind.REDIRECT) {
    const [command, redirects] = getRedirects(node)
    if (command !== null && command.type === NT.LIST) {
      // tree-sitter hoists a trailing redirect over the whole &&/||
      // list; bash binds it to the last command:
      //   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
      // Re-associate and defer target expansion until R runs, so
      // `cd /x && echo hi > f` writes under /x. Compound and subshell
      // bodies keep the whole-body redirect (bash group semantics).
      const [left, op, right] = getListParts(command)
      const wrapped = recurseReassociated.bind(
        null,
        recurse,
        dispatch,
        executeFn,
        registry,
        redirects,
        right,
      )
      return handleConnection(wrapped, left, op, right, session, stdin, callStack)
    }
    if (command !== null && command.type === NT.PIPELINE) {
      const [commands, stderrFlags] = getPipelineCommands(command)
      const right = commands[commands.length - 1]
      if (right === undefined) throw new Error('redirected pipeline: missing command')
      const wrapped = recurseReassociated.bind(
        null,
        recurse,
        dispatch,
        executeFn,
        registry,
        redirects,
        right,
      )
      return handlePipe(wrapped, commands, stderrFlags, session, stdin, callStack, executeFn)
    }
    const [expandedRedirects, pipeNode] = await expandRedirects(
      redirects,
      session,
      executeFn,
      registry,
      callStack,
      sessionView(session, registry.policies),
    )
    // `exec > file` with no command installs the redirects on the shell
    // for every later statement, rather than applying them to one
    // command. `exec cmd > file` still has a command and falls through
    // to the ordinary path, which refuses the command form.
    if (isBareExec(command)) {
      return await installExecRedirects(dispatch, session, expandedRedirects)
    }
    // Simple-command arguments expand before its redirects are installed.
    // Their diagnostics belong to this frame; compound bodies own theirs.
    const redirectRecurse =
      command?.type === NT.COMMAND
        ? (n: TSNodeLike, s: Session, i: ByteSource | null, cs: CallStack | null) =>
            walkNode(captureDeps, n, s, i, cs)
        : recurse
    let [stdout, io, execNode] = await handleRedirect(
      redirectRecurse,
      dispatch,
      command,
      expandedRedirects,
      session,
      stdin,
      callStack,
    )
    if (pipeNode !== null && stdout !== null) {
      const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
      stdout = stdout2
      io = await io.merge(io2)
      execNode = execNode2
    }
    return [stdout, io, execNode]
  }

  if (kind === NodeKind.SUBSHELL) {
    // A subshell is its own shell: background jobs started inside live
    // in a private job table (`$!`/`wait`/`kill` in the body see them;
    // the parent's table never does), mirroring bash's forked process.
    const subTable = new JobTable()
    const subDeps: ExecuteNodeDeps = { ...deps, jobTable: subTable }
    // The opts parameter is load-bearing, not decoration: a job started
    // inside the subshell body hands `handleBackground` its own console
    // and abort signal through it. Dropping it (a 4-parameter closure
    // still satisfies ExecuteNodeFn, since function parameters are
    // bivariant) would run the nested job against the enclosing job's
    // sink and signal instead.
    const subRecurse = (
      n: TSNodeLike,
      s: Session,
      inp: ByteSource | null,
      cs: CallStack | null,
      opts?: ExecuteNodeOpts,
    ): Promise<Result> => executeNode(withOpts(subDeps, opts), n, s, inp, cs)
    return handleSubshell(
      subRecurse,
      node.children,
      session,
      stdin,
      callStack,
      subTable,
      agentId,
      dispatch,
      executeFn,
    )
  }

  if (kind === NodeKind.COMPOUND && node.children[0]?.type === NT.ARITH_OPEN) {
    const text = getText(node)
    const expr = await expandArith(
      node,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    let result: ArithResult
    try {
      // Reads resolve against the visible env so a hidden name counts
      // as unset; a hidden write refuses below, in this command's own
      // voice like the readonly refusal.
      result = evaluateArith(expr, visibleEnv(session), 0, sessionElements(session))
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      const errBytes = new TextEncoder().encode(`bash: ((: ${expr}: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    for (const write of result.writes) {
      const name = write.name
      try {
        ensureVarVisible(session, name)
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        const errBytes = new TextEncoder().encode(`bash: ${err.message}\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
        ]
      }
      if (session.readonlyVars.has(name)) {
        const errBytes = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
        ]
      }
    }
    try {
      for (const write of result.writes) {
        await assignElement(
          session,
          sessionView(session, registry.policies),
          write.name,
          write.key,
          write.value,
        )
      }
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const errBytes = new TextEncoder().encode(`bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    const code = result.value !== 0n ? 0 : 1
    return [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: text, exitCode: code }),
    ]
  }

  if (kind === NodeKind.COMPOUND) {
    const allStdout: ByteSource[] = []
    let mergedIo = new IOResult()
    let lastExec = new ExecutionNode({ command: '{}', exitCode: 0 })
    for (const child of node.namedChildren) {
      if (child.type === NT.COMMENT) continue
      let result: Result
      try {
        result = await stream(child, session, stdin, callStack)
      } catch (err) {
        if (err instanceof ExitSignal)
          throw await prependExitOutput(err, asyncChain(...allStdout), mergedIo)
        throw err
      }
      const [rawStdout, io, execNode] = result
      lastExec = execNode
      const stdout = await finishStatement(rawStdout, io, session)
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(child.type) &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- recurse() mutates it
        !session.errexitImmune
      ) {
        mergedIo.exitCode = io.exitCode
        break
      }
    }
    if (allStdout.length === 1 && allStdout[0] !== undefined) {
      return [allStdout[0], mergedIo, lastExec]
    }
    const combined = allStdout.length > 0 ? asyncChain(...allStdout) : null
    return [combined, mergedIo, lastExec]
  }

  if (kind === NodeKind.IF) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIf(stream, branches, elseBody, session, stdin, callStack)
  }

  if (kind === NodeKind.CFOR) {
    const [exprs, body] = getCforParts(node)
    const evalExpr: CforEval = (e, d) =>
      evalCforExpr(e, d, session, executeFn, callStack, sessionView(session, registry.policies))
    return handleCfor(stream, exprs, body, evalExpr, session, stdin, callStack)
  }

  if (kind === NodeKind.FOR || kind === NodeKind.SELECT) {
    const [variable, values, body] = getForParts(node)
    const classified = await expandAndClassify(
      values,
      session,
      executeFn,
      registry,
      session.cwd,
      callStack,
      sessionView(session, registry.policies),
    )
    // The loop word list is consumed by the shell (WordPolicy.SHELL):
    // globs resolve to matches before iteration starts.
    const resolved = await resolveGlobs(
      classified,
      registry,
      session.shellOptions.noglob === true,
      deps.namespace,
      globOptions(session),
    )
    if (kind === NodeKind.SELECT) {
      return handleSelect(
        stream,
        variable,
        resolved,
        body,
        session,
        stdin,
        callStack,
        registry.policies,
      )
    }
    return handleFor(stream, variable, resolved, body, session, stdin, callStack, registry.policies)
  }

  if (kind === NodeKind.WHILE || kind === NodeKind.UNTIL) {
    const [condition, body] = getWhileParts(node)
    if (kind === NodeKind.UNTIL) {
      return handleUntil(stream, condition, body, session, stdin, callStack)
    }
    return handleWhile(stream, condition, body, session, stdin, callStack)
  }

  if (kind === NodeKind.CASE) {
    const wordNode = getCaseWord(node)
    const word = await expandNode(
      wordNode,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    const items: [string[], TSNodeLike[], string][] = []
    for (const [patternNodes, body, terminator] of getCaseItems(node)) {
      const patterns: string[] = []
      for (const patternNode of patternNodes) {
        patterns.push(
          await expandPattern(
            patternNode,
            session,
            executeFn,
            callStack,
            sessionView(session, registry.policies),
          ),
        )
      }
      items.push([patterns, body, terminator])
    }
    return handleCase(stream, word, items, session, stdin, callStack)
  }

  if (kind === NodeKind.FUNCTION_DEF) {
    const name = getFunctionName(node)
    if (session.readonlyFunctions.has(name)) {
      // `readonly -f f` froze the body: either definition syntax refuses
      // with `f: readonly function`, exit 1, and the old body stays,
      // pinned on 5.2.37.
      const err = new TextEncoder().encode(`bash: ${name}: readonly function\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: `function ${name}`, exitCode: 1, stderr: err }),
      ]
    }
    const body = getFunctionBody(node)
    session.functions[name] = body
    return [null, new IOResult(), new ExecutionNode({ command: `function ${name}`, exitCode: 0 })]
  }

  if (kind === NodeKind.DECLARATION) {
    const keyword = getDeclarationKeyword(node)
    const assignments: string[] = []
    // Array literals are staged, not stored: `readonly -a a=(y)` on an
    // already-readonly name has to fail with the old value intact.
    const staged: { name: string; append: boolean; items: string[] }[] = []
    // Option words are kept verbatim, in order, so `--` survives as an
    // end-of-options marker and the handlers can name the *first* bad option
    // letter the way bash does.
    const flagWords: string[] = []
    const flagChars = new Set<string>()
    const plusChars = new Set<string>()
    let optsDone = false
    for (const child of node.namedChildren) {
      if (child.type === NT.VARIABLE_ASSIGNMENT) {
        const valNodes = child.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
        const firstVal = valNodes[0]
        if (firstVal?.type === NT.ARRAY) {
          const text = getText(child)
          const eq = text.indexOf('=')
          const key = eq >= 0 ? text.slice(0, eq) : text
          const append = key.endsWith('+')
          staged.push({
            name: append ? key.slice(0, -1) : key,
            append,
            items: await expandArrayItems(
              firstVal,
              session,
              executeFn,
              registry,
              deps.namespace,
              callStack,
            ),
          })
          continue
        }
        assignments.push(
          await expandNode(
            child,
            session,
            executeFn,
            callStack,
            sessionView(session, registry.policies),
          ),
        )
      } else if (
        child.type === NT.SIMPLE_EXPANSION ||
        child.type === NT.EXPANSION ||
        child.type === NT.CONCATENATION ||
        child.type === NT.WORD ||
        // A bare `readonly NAME` / `export NAME` operand parses as a
        // variable_name, not a word, and a quoted assignment
        // (`export 'FOO=bar'`) as a plain string operand.
        child.type === NT.VARIABLE_NAME ||
        child.type === NT.STRING ||
        child.type === NT.RAW_STRING ||
        child.type === NT.ANSI_C_STRING ||
        child.type === NT.TRANSLATED_STRING
      ) {
        const expanded = await expandNode(
          child,
          session,
          executeFn,
          callStack,
          sessionView(session, registry.policies),
        )
        // An *unquoted* expansion that came back empty is removed by
        // word splitting, so `export $UNSET` is a bare `export` and
        // prints the listing. A quoted one is a real, empty operand:
        // GNU answers both `export ""` and `export "$UNSET"` with
        // ``export: `': not a valid identifier``, so it has to reach
        // the builtin rather than vanish here.
        if (expanded === '' && (child.type === NT.SIMPLE_EXPANSION || child.type === NT.EXPANSION))
          continue
        if (!optsDone && expanded.startsWith('-') && expanded.length > 1) {
          flagWords.push(expanded)
          if (expanded === '--') optsDone = true
          else for (const ch of expanded.slice(1)) flagChars.add(ch)
        } else if (
          !optsDone &&
          expanded.startsWith('+') &&
          expanded.length > 1 &&
          (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset')
        ) {
          // `+attr` turns an attribute off. Only the declare family
          // reads it: `export +x` and `readonly +r` are `not a valid
          // identifier` in GNU, so for those two the word falls through
          // as an operand and refuses there.
          for (const ch of expanded.slice(1)) plusChars.add(ch)
        } else {
          assignments.push(expanded)
        }
      }
    }
    const cmdWord = keyword === NT.LOCAL ? 'local' : keyword
    if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
      const refused = declareOptionRefusal(cmdWord, flagChars, plusChars)
      if (refused !== null) return refused
    }
    if (
      (flagChars.has('f') || flagChars.has('F')) &&
      (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset')
    ) {
      // `-f`/`-F` select functions, not variables: `-rf` freezes, `-f
      // NAME` prints the body, `-F NAME` prints the name, and a missing
      // name is exit 1 without a word.
      return handleDeclareFunctions(cmdWord, session, flagChars, assignments)
    }
    const isReadonly = keyword === 'readonly' || flagChars.has('r')
    // `-l` and `-u` cannot both hold; a cluster naming both sets neither
    // (pinned: `declare -lu s=aBc` prints `declare -- s`).
    let shaping = new Set(attrsFor('ilu', (c) => flagChars.has(c) && !plusChars.has(c)))
    if (shaping.has(VarAttr.Lower) && shaping.has(VarAttr.Upper)) {
      shaping = new Set([...shaping].filter((a) => a !== VarAttr.Lower && a !== VarAttr.Upper))
    }
    const conversionErrors: string[] = []
    if (flagChars.has('A') || flagChars.has('a')) {
      // `declare -a NAME` / `declare -A NAME` with no value declare an
      // empty array of that kind, so ${#NAME[@]} is 0 and an element
      // write leaves the other slots unassigned. GNU refuses to
      // convert between the two kinds and says so per name while the
      // rest of the operands still declare.
      const wantAssoc = flagChars.has('A')
      for (const bare of assignments) {
        if (bare.includes('=')) continue
        // Both branches below write array storage raw (the top-level
        // one migrates an existing scalar), so a hidden name refuses
        // like any assignment spelling before either lands.
        try {
          ensureVarVisible(session, bare)
        } catch (err) {
          if (!(err instanceof PolicyDenied)) throw err
          throw new ExitSignal(1, new TextEncoder().encode(`${err.message}\n`), null, 1)
        }
        if (wantAssoc && Object.hasOwn(session.arrays, bare)) {
          conversionErrors.push(
            `bash: ${cmdWord}: ${bare}: cannot convert indexed to associative array`,
          )
          continue
        }
        if (!wantAssoc && Object.hasOwn(session.assocs, bare)) {
          conversionErrors.push(
            `bash: ${cmdWord}: ${bare}: cannot convert associative to indexed array`,
          )
          continue
        }
        if (!flagChars.has('g') && noteLocalArray(session, bare)) {
          // Inside a function this shadows whatever the caller had with
          // a fresh empty array of the declared kind; `-g` declares at
          // global scope instead.
          seedVar(session, bare, wantAssoc ? {} : [])
        } else if (wantAssoc && !Object.hasOwn(session.assocs, bare)) {
          // At top level an existing scalar becomes the value at the
          // literal key "0" (GNU allows scalar-to-associative
          // conversion, unlike indexed).
          const scalar = session.env[bare]
          seedVar(session, bare, scalar === undefined ? {} : { '0': scalar })
        } else if (!wantAssoc && !Object.hasOwn(session.arrays, bare)) {
          // At top level an existing scalar becomes element 0.
          const scalar = session.env[bare]
          seedVar(session, bare, scalar === undefined ? [] : [scalar])
        }
      }
    }
    // Array literals travel as data: the handler stores them through
    // the session door and owns both refusal voices, so the executor
    // only expands and stages.
    if (isReadonly) {
      // Only the `readonly` keyword owns -p / illegal-option handling;
      // `declare -r` keeps names only.
      const declView = sessionView(session, registry.policies)
      const stored: string[] = []
      const result =
        keyword === 'readonly'
          ? await handleReadonly(
              [...flagWords, ...assignments],
              session,
              declView,
              staged,
              stored,
              flagChars.has('A'),
              shaping,
            )
          : await handleReadonly(
              assignments,
              session,
              declView,
              staged,
              stored,
              flagChars.has('A'),
              shaping,
            )
      // `declare -rx X=1` carries both attributes: GNU prints
      // `declare -rx X="1"`. Readonly answers first, so the export stamp
      // has to land here too, or `-r` silently ate the `-x`.
      const refused = await stampAttrs(
        session,
        declView,
        flagChars,
        plusChars,
        assignments,
        staged,
        stored,
      )
      return refused ?? mergeConversionErrors(result, conversionErrors)
    }
    // declare/typeset scope like `local` inside a function (bash
    // semantics) and assign globally at top level, which is exactly
    // handleLocal's fallback when no function scope is active.
    if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
      // `-p` prints rather than declares, so it is answered before the
      // assignment path runs at all.
      if (
        (flagChars.has('p') || plusChars.has('p')) &&
        (keyword === 'declare' || keyword === 'typeset')
      ) {
        return handleDeclarePrint(assignments, session)
      }
      const declView2 = sessionView(session, registry.policies)
      const stored2: string[] = []
      const result = await handleLocal(
        assignments,
        session,
        declView2,
        staged,
        // `declare`/`typeset` share this handler but have to name
        // themselves in a diagnostic rather than say `local`.
        cmdWord,
        stored2,
        flagChars.has('A'),
        shaping,
        flagChars.has('n') && !plusChars.has('n'),
        flagChars.has('g'),
      )
      const plusRefused = plusRefusals(cmdWord, session, declView2, plusChars, assignments, staged)
      if (plusRefused !== null) return plusRefused
      const refused2 = await stampAttrs(
        session,
        declView2,
        flagChars,
        plusChars,
        assignments,
        staged,
        stored2,
      )
      return refused2 ?? mergeConversionErrors(result, conversionErrors)
    }
    // Pass export flags through so -p / bare print and illegal options work.
    const exportResult = await handleExport(
      [...flagWords, ...assignments],
      session,
      sessionView(session, registry.policies),
      staged,
    )
    return mergeConversionErrors(exportResult, conversionErrors)
  }

  if (kind === NodeKind.UNSET) {
    return handleUnset(getUnsetArgs(node), session, sessionView(session, registry.policies))
  }

  if (kind === NodeKind.TEST) {
    const opener = node.children[0]?.type ?? '['
    if (opener === '[[') {
      const tree = await expandDoubleBracket(
        node,
        session,
        executeFn,
        callStack,
        sessionView(session, registry.policies),
      )
      return handleTest(dispatch, deps.namespace, tree, session, '[[')
    }
    const expanded = await expandTestExpr(
      node,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    return handleTest(dispatch, deps.namespace, expanded, session, '[')
  }

  if (kind === NodeKind.NEGATED) {
    const inner = getNegatedCommand(node)
    const [rawStdout, io, execNode] = await stream(inner, session, stdin, callStack)
    // Lazy exit codes (exitOnEmpty in grep) must be final before
    // inverting, or `! grep miss f` negates the provisional 0.
    const stdout = await applyBarrier(rawStdout, io, BarrierPolicy.VALUE)
    const flipped = new IOResult({
      exitCode: io.exitCode !== 0 ? 0 : 1,
      stderr: io.stderr,
      reads: io.reads,
      writes: io.writes,
      cache: io.cache,
    })
    execNode.exitCode = flipped.exitCode
    session.errexitImmune = true
    return [stdout, flipped, execNode]
  }

  if (kind === NodeKind.VAR_ASSIGN) {
    const text = getText(node)
    if (!text.includes('=')) {
      return [null, new IOResult(), new ExecutionNode({ command: text, exitCode: 0 })]
    }
    const subSeq = session.cmdsubSeq
    const subscriptNode = node.namedChildren.find((c) => c.type === 'subscript') ?? null
    const nameSource = subscriptNode ?? node
    const nameNode = nameSource.namedChildren.find((c) => c.type === NT.VARIABLE_NAME)
    const eq = text.indexOf('=')
    const spelled = nameNode !== undefined ? nameNode.text : text.slice(0, eq)
    // A name reference assigns to its target, whatever the shape of the
    // assignment; an unaimed one (`declare -n r; r=v`) resolves to itself
    // and takes the value as the target's name. The spelling is kept for
    // slicing the subscript out of the source.
    const key = deref(session, spelled) || spelled
    const append = node.children.some((c) => c.type === '+=')
    if (session.readonlyVars.has(key)) {
      // A bare assignment to a readonly variable is a fatal
      // variable-assignment error in non-interactive bash: the rest of
      // the line is abandoned (builtins like `export` merely fail with
      // 1 and continue).
      const err = new TextEncoder().encode(`bash: ${key}: readonly variable\n`)
      throw new ExitSignal(1, err, null, 1)
    }
    const valNodes = node.namedChildren.filter(
      (c) => c.type !== NT.VARIABLE_NAME && c.type !== 'subscript',
    )
    // Every branch below computes its resulting value with bash's own
    // mechanics on a copy, then stores through the one session door,
    // which owns the gate and the scalar/array invariant.
    const view = sessionView(session, registry.policies)
    const firstVal = valNodes[0]
    if (firstVal?.type === NT.ARRAY) {
      const items = await expandArrayItems(
        firstVal,
        session,
        executeFn,
        registry,
        deps.namespace,
        callStack,
      )
      const heldMap = session.assocs[key]
      if (heldMap !== undefined) {
        const { map, badWords } = buildAssocLiteral(heldMap, items, append)
        await assignVar(view, key, map)
        if (badWords.length > 0) {
          const errBytes = new TextEncoder().encode(
            badWords
              .map(
                (word) =>
                  `bash: ${key}: '${word}': must use subscript when assigning associative array`,
              )
              .join('\n') + '\n',
          )
          return [
            null,
            new IOResult({ exitCode: 1, stderr: errBytes }),
            new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
          ]
        }
        const mapCode = assignmentStatus(session, subSeq)
        return [
          null,
          new IOResult({ exitCode: mapCode }),
          new ExecutionNode({ command: text, exitCode: mapCode }),
        ]
      }
      let held: ShellArray | null = session.arrays[key] ?? null
      if (append && held === null) {
        const scalar = session.env[key]
        held = scalar === undefined ? null : [scalar]
      }
      // `arr+=(...)` starts at the extent, so it fills the hole a
      // trailing `unset arr[last]` left but skips interior ones; a
      // `[i]=v` element places at i and the next plain word continues
      // from there.
      const base = buildIndexedLiteral(held, items, append, (sub) =>
        elementIndex(sub, visibleEnv(session), sessionElements(session)),
      )
      await assignVar(view, key, base)
      const arrCode = assignmentStatus(session, subSeq)
      return [
        null,
        new IOResult({ exitCode: arrCode }),
        new ExecutionNode({ command: text, exitCode: arrCode }),
      ]
    }
    let val = text.slice(eq + 1)
    if (firstVal !== undefined) {
      val = await expandNode(
        firstVal,
        session,
        executeFn,
        callStack,
        sessionView(session, registry.policies),
      )
    }
    if (subscriptNode !== null) {
      const subText = await subscriptKeyText(
        subscriptNode,
        spelled,
        session,
        executeFn,
        callStack,
        sessionView(session, registry.policies),
      )
      const heldMap = session.assocs[key]
      const rawSub = subscriptNode.text.slice(spelled.length + 1, -1)
      if (rawSub.trim() === '' || (heldMap !== undefined && subText === '')) {
        // bash aborts the whole line on a bad assignment subscript
        // (status 1), naming the raw spelling (`m[$e]: bad array
        // subscript`). An indexed subscript that merely *expands*
        // empty stays legal (arithmetic on nothing is 0), so only the
        // associative kind checks the expanded text.
        const nameText = text.slice(0, eq).replace(/\+$/, '')
        throw new ExitSignal(
          1,
          new TextEncoder().encode(`bash: ${nameText}: bad array subscript\n`),
          null,
          1,
        )
      }
      if (heldMap !== undefined) {
        // The subscript is the key: no arithmetic, `m[1+1]` writes the
        // key "1+1".
        const newMap = { ...heldMap }
        newMap[subText] = append ? (heldMap[subText] ?? '') + val : val
        await assignVar(view, key, newMap)
        const mapCode = assignmentStatus(session, subSeq)
        return [
          null,
          new IOResult({ exitCode: mapCode }),
          new ExecutionNode({ command: text, exitCode: mapCode }),
        ]
      }
      const existing = session.arrays[key]
      let arr: ShellArray
      if (existing === undefined) {
        const scalar = session.env[key]
        arr = scalar === undefined ? [] : [scalar]
      } else {
        arr = [...existing]
      }
      let idx = arrayIndex(subText, visibleEnv(session), sessionElements(session))
      if (idx < 0) idx += arrayExtent(arr)
      if (idx < 0) {
        // Same fatal shape as the empty subscript above.
        const nameText = text.slice(0, eq).replace(/\+$/, '')
        throw new ExitSignal(
          1,
          new TextEncoder().encode(`bash: ${nameText}: bad array subscript\n`),
          null,
          1,
        )
      }
      arraySet(arr, idx, append ? arrayGet(arr, idx) + val : val)
      await assignVar(view, key, arr)
      const subCode = assignmentStatus(session, subSeq)
      return [
        null,
        new IOResult({ exitCode: subCode }),
        new ExecutionNode({ command: text, exitCode: subCode }),
      ]
    }
    const heldMap = session.assocs[key]
    const heldArr = session.arrays[key]
    if (heldMap !== undefined) {
      // `m=x` on an associative array writes the literal key "0" and
      // keeps every other key, as bash does.
      const newMap = { ...heldMap }
      newMap['0'] = append ? (heldMap['0'] ?? '') + val : val
      await assignVar(view, key, newMap)
    } else if (heldArr !== undefined) {
      // `a=x` writes element 0 and keeps the rest; `a+=x` appends onto
      // element 0.
      const newArr = [...heldArr]
      arraySet(newArr, 0, append ? arrayGet(newArr, 0) + val : val)
      await assignVar(view, key, newArr)
    } else {
      const heldVar = session.vars[key]
      let newVal: string
      if (append && heldVar?.attrs.has(VarAttr.Integer) === true) {
        // `n+=3` on an integer name adds: the door evaluates `old + new`,
        // so `declare -i n=5; n+=3` stores 8, not 53.
        newVal = `${session.env[key] ?? '0'} + (${val})`
      } else {
        newVal = append ? (session.env[key] ?? '') + val : val
      }
      await assignVar(view, key, newVal)
    }
    // Reassigning OPTIND (even to its current value) restarts the getopts
    // scan, matching bash's internal char pointer.
    if (key === 'OPTIND') session.getoptsOptind = null
    const code = assignmentStatus(session, subSeq)
    const assignIo = new IOResult({ exitCode: code })
    if (session.shellOptions.xtrace === true) {
      assignIo.stderr = traceAssignment(key, val, append)
    }
    return [null, assignIo, new ExecutionNode({ command: text, exitCode: code })]
  }

  // Assignment-only statement (a=1 b=2).
  if (kind === NodeKind.VAR_ASSIGNS) {
    const subSeq = session.cmdsubSeq
    let mergedIo = new IOResult()
    for (const child of node.namedChildren) {
      if (child.type !== NT.VARIABLE_ASSIGNMENT) continue
      const [, io] = await recurse(child, session, stdin, callStack)
      mergedIo = await mergedIo.merge(io)
    }
    // The statement's status follows the last command substitution
    // performed across ALL its assignments, not the last child's.
    const code = assignmentStatus(session, subSeq)
    mergedIo.exitCode = code
    return [null, mergedIo, new ExecutionNode({ command: getText(node), exitCode: code })]
  }

  // Constructs the parser accepts but the executor cannot honor (e.g.
  // C-style `for ((;;))`). Mirrors the unsupported-builtin diagnostic
  // so agents see a capability gap, not a crash.
  const unsupportedErr = new TextEncoder().encode(
    `mirage: unsupported shell construct: ${node.type}\n`,
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: unsupportedErr }),
    new ExecutionNode({ command: node.text, exitCode: 2, stderr: unsupportedErr }),
  ]
}

export type { ExecuteNodeDeps } from '../executor/types.ts'
