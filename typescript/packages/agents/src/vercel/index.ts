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

import { encodeBase64 } from '@struktoai/mirage-core/utils/base64'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { readWorkspaceFile } from '../read_file.ts'
import {
  EDIT_DESCRIPTION,
  EDIT_INPUT,
  GLOB_DESCRIPTION,
  GLOB_INPUT,
  GREP_DESCRIPTION,
  GREP_INPUT,
  LS_DESCRIPTION,
  LS_INPUT,
  READ_DESCRIPTION,
  READ_INPUT,
  SHELL_DESCRIPTION,
  SHELL_INPUT,
  WRITE_DESCRIPTION,
  WRITE_INPUT,
} from '../tool_descriptions.ts'
import {
  MirageToolOperations,
  type MirageToolOperationsOptions,
  type ToolResult,
} from '../tool_operations.ts'

interface Answer {
  text: string
  isError: boolean
}

type ReadAnswer =
  | Answer
  | { kind: 'media'; path: string; mimeType: string; base64: string; bytes: number }

function answer(result: ToolResult): Answer {
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

/**
 * Mirage's tool table as AI SDK tools: shell, read, write, edit, ls, grep
 * and glob, each with the shared input schema and answering
 * `{ text, isError }` as the MCP tool of the same name does. `read` also
 * hands an image or a PDF to the model as a file, which the AI SDK can
 * carry and the text answer cannot.
 */
export function mirageTools(ws: Workspace, options: MirageToolOperationsOptions = {}): ToolSet {
  const operations = new MirageToolOperations(ws, options)
  const mirageTool = (name: string, description: string, input: object) =>
    tool({
      description,
      inputSchema: jsonSchema<Record<string, unknown>>(input as never),
      execute: async (args: Record<string, unknown>) => answer(await operations.call(name, args)),
    })
  return {
    shell: mirageTool('shell', SHELL_DESCRIPTION, SHELL_INPUT),
    read: tool({
      description: `${READ_DESCRIPTION} Images and PDFs come back as files the model can see.`,
      inputSchema: jsonSchema<Record<string, unknown>>(READ_INPUT as never),
      execute: async (args: Record<string, unknown>): Promise<ReadAnswer> => {
        const path = args.path as string
        if (await ws.vfs.isFile(path, options.sessionId)) {
          const sniffed = await readWorkspaceFile(ws, path, (p) =>
            ws.vfs.read(p, { raw: true }, options.sessionId),
          )
          if (sniffed.kind === 'image' || sniffed.kind === 'file') {
            return {
              kind: 'media',
              path: sniffed.path,
              mimeType: sniffed.mimeType,
              base64: encodeBase64(sniffed.data),
              bytes: sniffed.bytes,
            }
          }
          if (sniffed.kind === 'binary') return { text: sniffed.note, isError: false }
        }
        return answer(await operations.call('read', args))
      },
      toModelOutput: ({ output }) => {
        const out: ReadAnswer = output
        if ('kind' in out) {
          return {
            type: 'content',
            value: [
              { type: 'text', text: `[${out.path}] ${out.mimeType} (${String(out.bytes)} bytes)` },
              { type: 'file', data: { type: 'data', data: out.base64 }, mediaType: out.mimeType },
            ],
          }
        }
        return out.isError
          ? { type: 'error-text', value: out.text }
          : { type: 'text', value: out.text }
      },
    }),
    write: mirageTool('write', WRITE_DESCRIPTION, WRITE_INPUT),
    edit: mirageTool('edit', EDIT_DESCRIPTION, EDIT_INPUT),
    ls: mirageTool('ls', LS_DESCRIPTION, LS_INPUT),
    grep: mirageTool('grep', GREP_DESCRIPTION, GREP_INPUT),
    glob: mirageTool('glob', GLOB_DESCRIPTION, GLOB_INPUT),
  }
}
