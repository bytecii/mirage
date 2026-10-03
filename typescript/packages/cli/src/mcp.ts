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

import { resolveWorkspaceConfig } from '@struktoai/mirage-server/workspace_config'
import type { Command } from 'commander'
import { makeClient, type DaemonClient } from './client.ts'
import { fail, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

export interface McpConfigResolutionOptions {
  cwd?: string
  env?: Record<string, string | undefined>
}

interface McpCommandOptions {
  workspace?: string
  session?: string
}

export function resolveMcpConfig(
  config: string | undefined,
  options: McpConfigResolutionOptions = {},
): string {
  return resolveWorkspaceConfig(config, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    envNames: ['MIRAGE_MCP_CONFIG', 'MIRAGE_CONFIG'],
  })
}

/** Whether a daemon workspace holds a session. */
async function hasSession(
  client: DaemonClient,
  workspacePath: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await handleResponse(await client.request('GET', `${workspacePath}/sessions`))
  return (
    Array.isArray(rows) &&
    rows.some((row) => (row as { sessionId?: unknown }).sessionId === sessionId)
  )
}

/**
 * Serve a workspace's MCP tools over stdio. The tools are the daemon's:
 * this relays stdio to the workspace's `/v1/workspaces/:id/mcp`
 * endpoint, starting the daemon when it is not running. A config with no
 * `workspace_id` makes a workspace that lives as long as this process, as
 * a stdio server's state does. A workspace with a name, the config's
 * `workspace_id` or `--workspace`, outlives it. The daemon answers a
 * config's name with the live workspace created from that same config,
 * and refuses it when the live one came from another. `--session` serves
 * the tools as that session, under its profile, as it does for
 * `mirage shell`.
 */
async function runMcp(config: string | undefined, options: McpCommandOptions): Promise<void> {
  if (options.workspace !== undefined && config !== undefined) {
    fail('pass a config or --workspace, not both', 2)
  }
  let path: string | undefined
  if (options.workspace === undefined) {
    try {
      path = resolveMcpConfig(config)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), 2)
    }
  }
  const client = makeClient(loadDaemonSettings())
  try {
    await client.ensureRunning({ allowSpawn: true })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  let workspaceId: string
  let minted = false
  if (path !== undefined) {
    const { checkWorkspaceConfigFile } = await import('@struktoai/mirage-node/config')
    const loaded = checkWorkspaceConfigFile(path)
    const body = JSON.stringify({ config: loaded })
    const created = await handleResponse(await client.request('POST', '/v1/workspaces', { body }))
    workspaceId = (created as { id: string }).id
    minted = typeof loaded.workspace_id !== 'string' || loaded.workspace_id === ''
  } else {
    workspaceId = options.workspace ?? ''
    await handleResponse(
      await client.request('GET', `/v1/workspaces/${encodeURIComponent(workspaceId)}`),
    )
  }
  const workspacePath = `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const query =
    options.session === undefined ? '' : `?sessionId=${encodeURIComponent(options.session)}`
  const url = `${client.settings.url}${workspacePath}/mcp${query}`
  const token = client.settings.authToken
  const headers: Record<string, string> = token === '' ? {} : { Authorization: `Bearer ${token}` }
  if (
    options.session !== undefined &&
    !(await hasSession(client, workspacePath, options.session))
  ) {
    if (minted) await client.request('DELETE', workspacePath)
    fail(`session not found: ${options.session}`, 2)
  }
  const { relayStdio } = await import('@struktoai/mirage-server/mcp')
  try {
    await relayStdio(url, headers)
  } finally {
    if (minted) await client.request('DELETE', workspacePath)
  }
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .argument('[config]', 'Mirage workspace YAML config')
    .option('-w, --workspace <id>', 'Serve this daemon workspace instead of loading a config')
    .option('-s, --session <id>', "Session the tools act as; the workspace's default when absent")
    .description("Serve a Mirage workspace's MCP tools over stdio.")
    .action(runMcp)
}
