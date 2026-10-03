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

import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server'
import {
  EDIT_INPUT,
  GLOB_INPUT,
  GREP_INPUT,
  LS_INPUT,
  READ_INPUT,
  WRITE_INPUT,
} from '@struktoai/mirage-agents/tool_descriptions'
import type { FastifyInstance } from 'fastify'
import type { McpDoor } from '../mcp/http.ts'

export interface ToolsRoutesDeps {
  mcp: McpDoor
}

const INPUTS = {
  read: READ_INPUT,
  write: WRITE_INPUT,
  edit: EDIT_INPUT,
  ls: LS_INPUT,
  grep: GREP_INPUT,
  glob: GLOB_INPUT,
}

interface ToolResponse {
  text: string
  isError: boolean
}

/**
 * Run one tool for an HTTP caller, as MCP runs it: the body is the
 * tool's input, checked against the same schema MCP checks it against,
 * and the call goes to the table the MCP endpoint serves the session
 * with, so a read over HTTP stamps the file for an edit over MCP and
 * back. Answers the status and body to send.
 */
async function callTool(
  mcp: McpDoor,
  workspaceId: string,
  name: string,
  args: unknown,
  sessionId: string | null,
): Promise<{ status: number; body: ToolResponse | { detail: string } }> {
  const input = INPUTS[name as keyof typeof INPUTS]
  const checked = await fromJsonSchema(input as JsonSchemaType)['~standard'].validate(args)
  if (checked.issues !== undefined) {
    const why = checked.issues.map((issue) => issue.message).join('; ')
    return { status: 400, body: { detail: `Invalid arguments for tool ${name}: ${why}` } }
  }
  const tools = await mcp.tools(workspaceId, sessionId)
  if (typeof tools === 'string') return { status: 404, body: { detail: tools } }
  try {
    const result = await tools.call(name, args as Record<string, unknown>)
    return {
      status: 200,
      body: { text: result.content[0]?.text ?? '', isError: result.isError === true },
    }
  } catch (err) {
    return {
      status: 200,
      body: { text: err instanceof Error ? err.message : String(err), isError: true },
    }
  }
}

/** Serve each tool but `shell` at `POST /v1/workspaces/:wsId/<tool>`; `shell` keeps its own route. */
export function registerToolsRoutes(app: FastifyInstance, deps: ToolsRoutesDeps): void {
  for (const name of Object.keys(INPUTS)) {
    app.post<{ Params: { wsId: string }; Querystring: { sessionId?: string } }>(
      `/v1/workspaces/:wsId/${name}`,
      async (req, reply) => {
        const { status, body } = await callTool(
          deps.mcp,
          req.params.wsId,
          name,
          req.body,
          req.query.sessionId ?? null,
        )
        return reply.status(status).send(body)
      },
    )
  }
}
