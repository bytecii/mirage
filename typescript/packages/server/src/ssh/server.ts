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

import { existsSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type * as Ssh2Mod from 'ssh2'
import type { AuthContext, Connection, ParsedKey, PseudoTtyInfo, ServerChannel } from 'ssh2'
import type { WorkspaceRegistry } from '../registry.ts'
import type { SSHConfig } from './config.ts'
import { SSHConfigError } from './errors.ts'
import { loadHostKey } from './keys.ts'
import {
  handleChannel,
  refuseSubsystem,
  type ChannelRequest,
  type Endpoint,
  type ShellChannel,
} from './session.ts'
import { serveSFTP } from './sftp.ts'
import type { SSHListener } from './types.ts'

/**
 * ssh2 is CommonJS, and Node's ESM loader names only the exports it can
 * find statically (`Client`, not `Server` or `utils`); the whole module is
 * its default export.
 */
async function loadSsh2(): Promise<typeof Ssh2Mod> {
  let mod: typeof Ssh2Mod & { default?: typeof Ssh2Mod }
  try {
    mod = await import('ssh2')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new SSHConfigError(
      `ssh_port is set but the SSH server needs ssh2; install it beside the daemon (npm install ssh2): ${message}`,
    )
  }
  return mod.default ?? mod
}

/**
 * The public keys allowed to log in, read fresh for every attempt so a key
 * added or revoked takes effect on the next login. A line ssh2 cannot read
 * is skipped with a warning; that includes a line carrying OpenSSH key
 * options (`command=`, `from=`, ...), which this door does not honor and
 * so will not accept as if they were absent.
 */
export function readAuthorizedKeys(path: string, utils: typeof Ssh2Mod.utils): ParsedKey[] {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`ssh: refusing logins, cannot read ${path}: ${message}`)
    return []
  }
  const keys: ParsedKey[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const parsed = utils.parseKey(line)
    if (parsed instanceof Error) {
      console.warn(`ssh: skipping an authorized key that cannot be read: ${parsed.message}`)
      continue
    }
    keys.push(parsed)
  }
  return keys
}

/**
 * Admit a public key in the authorized keys, and nothing else: no
 * passwords, no keyboard-interactive. A key the client only offers is
 * accepted as usable; a signed attempt must verify.
 */
function authenticate(ctx: AuthContext, keysFile: string, utils: typeof Ssh2Mod.utils): boolean {
  if (ctx.method !== 'publickey') {
    ctx.reject(['publickey'])
    return false
  }
  const offered = ctx.key.data
  const match = readAuthorizedKeys(keysFile, utils).find((k) => k.getPublicSSH().equals(offered))
  if (match === undefined) {
    ctx.reject(['publickey'])
    return false
  }
  if (ctx.signature !== undefined && ctx.blob !== undefined) {
    if (!match.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
      ctx.reject(['publickey'])
      return false
    }
  }
  ctx.accept()
  return true
}

function serveConnection(
  client: Connection,
  registry: WorkspaceRegistry,
  config: SSHConfig,
  utils: typeof Ssh2Mod.utils,
  peer: Endpoint,
  local: Endpoint,
): void {
  let username = ''
  client.on('authentication', (ctx) => {
    if (authenticate(ctx, config.authorizedKeysFile, utils)) username = ctx.username
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      let term: string | null = null
      let shell: ShellChannel | null = null
      const start = (channel: ServerChannel, command: string | null): void => {
        const request: ChannelRequest = { username, command, term, peer, local }
        void handleChannel(registry, channel, request, (s) => {
          shell = s
        })
      }
      session.on('pty', (acceptPty, _reject, info) => {
        term = (info as PseudoTtyInfo & { term?: string }).term ?? ''
        acceptPty()
      })
      session.on('window-change', (acceptResize) => {
        acceptResize()
      })
      session.on('signal', (acceptSignal) => {
        acceptSignal()
        shell?.signal()
      })
      session.on('shell', (acceptShell) => {
        start(acceptShell(), null)
      })
      session.on('exec', (acceptExec, _reject, info) => {
        start(acceptExec(), info.command)
      })
      session.on('sftp', (acceptSftp) => {
        serveSFTP(registry, username, acceptSftp())
      })
      session.on('subsystem', (acceptSubsystem, _reject, info) => {
        refuseSubsystem(acceptSubsystem(), info.name)
      })
    })
  })
  client.on('error', (err: NodeJS.ErrnoException) => {
    // A client that vanishes mid-handshake or mid-session resets the
    // socket; that ends its channels, and is not the daemon's failure.
    if (err.code !== 'ECONNRESET') console.warn(`ssh: connection error: ${err.message}`)
  })
}

/**
 * Listen for SSH, serving the daemon's workspaces.
 *
 * `ssh <workspace-id>@host` opens a shell in that workspace, `ssh
 * <workspace-id>@host cmd` runs one line, and `sftp`/`scp` reach its
 * files. Each channel runs as a fresh mirage session under the
 * workspace's default profile. ssh2 is loaded here, on first use, the way
 * the Python daemon loads asyncssh only once a port is set.
 */
export async function startSSHServer(
  registry: WorkspaceRegistry,
  config: SSHConfig,
): Promise<SSHListener> {
  const ssh2 = await loadSsh2()
  if (!existsSync(config.authorizedKeysFile)) {
    console.warn(
      `ssh: ${config.authorizedKeysFile} does not exist; every login will be refused until it holds a public key`,
    )
  }
  const hostKey = loadHostKey(config.hostKeyFile, ssh2.utils)
  const clients = new Set<Connection>()
  let port = config.port
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client, info) => {
    clients.add(client)
    client.on('close', () => {
      clients.delete(client)
    })
    const peer = { address: info.ip, port: info.port }
    serveConnection(client, registry, config, ssh2.utils, peer, { address: config.host, port })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port
  return {
    port,
    close: async () => {
      for (const client of clients) client.end()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
