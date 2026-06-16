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

import type { ExecuteResult, Workspace } from '@struktoai/mirage-core'
import { VERSION, gnuDirname } from '@struktoai/mirage-core'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { decode, ioToStr } from '../io-text.ts'
import {
  EDIT_DESCRIPTION,
  EXECUTE_DESCRIPTION,
  GREP_DESCRIPTION,
  LS_DESCRIPTION,
  READ_DESCRIPTION,
  WRITE_DESCRIPTION,
} from './descriptions.ts'

export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function ioResult(io: ExecuteResult): ToolResult {
  const result = textResult(ioToStr(io))
  if (io.exitCode !== 0) result.isError = true
  return result
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function ensureParents(ws: Workspace, path: string): Promise<void> {
  const parent = gnuDirname(path)
  if (parent === '/' || parent === '' || parent === '.') return
  if (await ws.fs.exists(parent)) return
  await ensureParents(ws, parent)
  try {
    await ws.fs.mkdir(parent)
  } catch (err) {
    if (!(await ws.fs.exists(parent))) throw err
  }
}

export async function runExecute(ws: Workspace, command: string): Promise<ToolResult> {
  return ioResult(await ws.execute(command))
}

export async function runRead(
  ws: Workspace,
  path: string,
  offset = 0,
  limit = 2000,
): Promise<ToolResult> {
  let data: Uint8Array
  try {
    data = await ws.fs.readFile(path)
  } catch (err) {
    if (!(await ws.fs.exists(path))) {
      return errorResult(`Error: file '${path}' not found`)
    }
    return errorResult(`Error: ${err instanceof Error ? err.message : String(err)}`)
  }
  const text = decode(data)
  const raw = text.length === 0 ? [] : text.split(/(?<=\n)/)
  const lines = raw.length > 0 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw
  const sliced = lines.slice(offset, offset + limit)
  const numbered = sliced.map((line, i) => `${String(i + offset + 1).padStart(6)}\t${line}`)
  return textResult(numbered.join(''))
}

export async function runWrite(ws: Workspace, path: string, content: string): Promise<ToolResult> {
  if (await ws.fs.exists(path)) {
    return errorResult(`Error: file '${path}' already exists`)
  }
  await ensureParents(ws, path)
  await ws.fs.writeFile(path, content)
  return textResult(`Written: ${path}`)
}

export async function runEdit(
  ws: Workspace,
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<ToolResult> {
  let content: string
  try {
    content = await ws.fs.readFileText(path)
  } catch {
    return errorResult(`Error: file '${path}' not found`)
  }
  const count = content.split(oldString).length - 1
  if (count === 0) {
    return errorResult(`Error: string not found in file: '${oldString}'`)
  }
  if (count > 1 && !replaceAll) {
    return errorResult(`Error: string appears ${String(count)} times. Pass replace_all=true`)
  }
  const newContent = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString)
  await ws.fs.writeFile(path, newContent)
  const occurrences = replaceAll ? count : 1
  return textResult(`Edited: ${path} (${String(occurrences)} occurrence(s))`)
}

export async function runLs(ws: Workspace, path: string): Promise<ToolResult> {
  return ioResult(await ws.execute(`ls ${shQuote(path)}`))
}

export async function runGrep(ws: Workspace, pattern: string, path: string): Promise<ToolResult> {
  const io = await ws.execute(`grep -rn ${shQuote(pattern)} ${shQuote(path)}`)
  return textResult(ioToStr(io))
}

export function MirageServer(workspace: Workspace) {
  return createSdkMcpServer({
    name: 'mirage',
    version: VERSION,
    alwaysLoad: true,
    tools: [
      tool('execute_command', EXECUTE_DESCRIPTION, { command: z.string() }, (args) =>
        runExecute(workspace, args.command),
      ),
      tool(
        'read',
        READ_DESCRIPTION,
        { path: z.string(), offset: z.number().optional(), limit: z.number().optional() },
        (args) => runRead(workspace, args.path, args.offset, args.limit),
        { annotations: { readOnlyHint: true } },
      ),
      tool('write', WRITE_DESCRIPTION, { path: z.string(), content: z.string() }, (args) =>
        runWrite(workspace, args.path, args.content),
      ),
      tool(
        'edit',
        EDIT_DESCRIPTION,
        {
          path: z.string(),
          old_string: z.string(),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        },
        (args) => runEdit(workspace, args.path, args.old_string, args.new_string, args.replace_all),
      ),
      tool('ls', LS_DESCRIPTION, { path: z.string() }, (args) => runLs(workspace, args.path), {
        annotations: { readOnlyHint: true },
      }),
      tool(
        'grep',
        GREP_DESCRIPTION,
        { pattern: z.string(), path: z.string() },
        (args) => runGrep(workspace, args.pattern, args.path),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  })
}
