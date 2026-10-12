import process from 'node:process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { buildApp } = await import(
  pathToFileURL(resolve(root, 'typescript/packages/server/dist/index.js'))
)
const app = buildApp({ authConfig: { mode: 'local' }, stateRoot: process.argv[3] })
await app.listen({ host: '127.0.0.1', port: Number(process.argv[2]) })
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0))
})
