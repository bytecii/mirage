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

import { VERSION } from '@struktoai/mirage-core/version'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server'
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
} from '@struktoai/mirage-agents/tool_descriptions'
import {
  MirageToolOperations,
  type MirageToolOperationsOptions,
} from '@struktoai/mirage-agents/tool_operations'

export interface MirageMcpServerOptions extends MirageToolOperationsOptions {
  name?: string
  version?: string
  /**
   * The tool table to serve, built from the workspace and these options
   * when absent. The HTTP door builds a server per request around one
   * table, so the read a request stamps guards the next request's edit.
   */
  operations?: MirageToolOperations
}

export function createMirageMcpServer(
  workspace: Workspace,
  options: MirageMcpServerOptions = {},
): McpServer {
  const operations = options.operations ?? new MirageToolOperations(workspace, options)
  const server = new McpServer({
    name: options.name ?? 'mirage',
    version: options.version ?? VERSION,
  })

  server.registerTool(
    'shell',
    {
      description: SHELL_DESCRIPTION,
      inputSchema: fromJsonSchema<{ command: string }>(SHELL_INPUT as JsonSchemaType),
    },
    (args) => operations.call('shell', args),
  )
  server.registerTool(
    'read',
    {
      description: READ_DESCRIPTION,
      inputSchema: fromJsonSchema<{ path: string; offset?: number; limit?: number }>(
        READ_INPUT as JsonSchemaType,
      ),
      annotations: { readOnlyHint: true },
    },
    (args) => operations.call('read', args),
  )
  server.registerTool(
    'write',
    {
      description: WRITE_DESCRIPTION,
      inputSchema: fromJsonSchema<{ path: string; content: string }>(WRITE_INPUT as JsonSchemaType),
    },
    (args) => operations.call('write', args),
  )
  server.registerTool(
    'edit',
    {
      description: EDIT_DESCRIPTION,
      inputSchema: fromJsonSchema<{
        path: string
        old_string: string
        new_string: string
        replace_all?: boolean
      }>(EDIT_INPUT as JsonSchemaType),
    },
    (args) => operations.call('edit', args),
  )
  server.registerTool(
    'ls',
    {
      description: LS_DESCRIPTION,
      inputSchema: fromJsonSchema<{ path: string }>(LS_INPUT as JsonSchemaType),
      annotations: { readOnlyHint: true },
    },
    (args) => operations.call('ls', args),
  )
  server.registerTool(
    'grep',
    {
      description: GREP_DESCRIPTION,
      inputSchema: fromJsonSchema<{
        pattern: string
        path: string
        ignore_case?: boolean
        fixed_strings?: boolean
        include?: string
        context?: number
        files_with_matches?: boolean
        count?: boolean
        max_count?: number
      }>(GREP_INPUT as JsonSchemaType),
      annotations: { readOnlyHint: true },
    },
    (args) => operations.call('grep', args),
  )
  server.registerTool(
    'glob',
    {
      description: GLOB_DESCRIPTION,
      inputSchema: fromJsonSchema<{ pattern: string; path?: string }>(GLOB_INPUT as JsonSchemaType),
      annotations: { readOnlyHint: true },
    },
    (args) => operations.call('glob', args),
  )

  return server
}
