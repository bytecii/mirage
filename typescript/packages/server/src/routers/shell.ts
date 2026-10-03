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

import { Buffer } from 'node:buffer'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { WorkspaceRegistry } from '../registry.ts'
import { JobStatus, type JobTable } from '../jobs.ts'
import { ioResultToDict } from '../io_serde.ts'

export interface ShellRoutesDeps {
  registry: WorkspaceRegistry
  jobs: JobTable
}

interface ShellParams {
  wsId: string
}

const ShellBodySchema = z
  .object({
    command: z.string(),
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
    cwd: z.string().optional(),
    runtime: z.string().optional(),
    stdinBase64: z.string().optional(),
    record: z.boolean().optional(),
  })
  .strict()

type ShellBody = z.infer<typeof ShellBodySchema>

async function parseShellBody(req: FastifyRequest): Promise<[ShellBody, Uint8Array | undefined]> {
  if (!req.isMultipart()) {
    const body = ShellBodySchema.parse(req.body)
    return [
      body,
      body.stdinBase64 === undefined ? undefined : Buffer.from(body.stdinBase64, 'base64'),
    ]
  }
  let request: unknown
  let stdin: Uint8Array | undefined
  for await (const part of req.parts({ limits: { parts: 2 } })) {
    if (part.type === 'field' && part.valueTruncated) {
      throw Object.assign(new Error('multipart field is too large'), { statusCode: 413 })
    }
    const value = part.type === 'file' ? await part.toBuffer() : part.value
    if (part.fieldname === 'request') {
      request =
        typeof value === 'string' || Buffer.isBuffer(value) ? JSON.parse(value.toString()) : value
    } else if (part.fieldname === 'stdin') {
      stdin = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    }
  }
  return [ShellBodySchema.parse(request), stdin]
}

interface ShellQuery {
  background?: string
}

export function registerShellRoutes(app: FastifyInstance, deps: ShellRoutesDeps): void {
  app.post<{ Params: ShellParams; Body: ShellBody; Querystring: ShellQuery }>(
    '/v1/workspaces/:wsId/shell',
    async (req, reply) => {
      const { wsId } = req.params
      if (!deps.registry.has(wsId)) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      let body: ShellBody
      let stdin: Uint8Array | undefined
      try {
        ;[body, stdin] = await parseShellBody(req)
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) {
          return reply.status(400).send({ detail: `bad shell request: ${error.message}` })
        }
        throw error
      }
      const background = req.query.background === 'true'
      const entry = deps.registry.get(wsId)
      await entry.runner.ws.ensureSessionsLoaded()
      const sessionId = body.sessionId ?? entry.runner.ws.defaultSessionId
      let job = await deps.jobs.submit(
        wsId,
        body.command,
        async (signal, executionScope) =>
          ioResultToDict(
            await entry.runner.ws.shell(body.command, {
              sessionId,
              executionScope,
              ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
              ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
              ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
              ...(body.record !== undefined ? { record: body.record } : {}),
              // Pyodide rejects Node Buffer even though it subclasses Uint8Array.
              ...(stdin !== undefined ? { stdin: new Uint8Array(stdin) } : {}),
              signal,
            }),
          ),
        sessionId,
      )
      if (background) {
        return reply.status(202).send({
          jobId: job.id,
          workspaceId: wsId,
          submittedAt: job.submittedAt,
        })
      }
      job = await deps.jobs.wait(job.id)
      reply.header('X-Mirage-Job-Id', job.id)
      if (job.status === JobStatus.CANCELED) {
        return reply.status(499).send({ detail: 'job canceled' })
      }
      if (job.status === JobStatus.FAILED) {
        return reply.status(500).send({ detail: job.error ?? 'shell failed' })
      }
      return job.result
    },
  )
}
