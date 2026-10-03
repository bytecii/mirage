import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, preview } from 'vite'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../../', import.meta.url))
const outDir = await mkdtemp(join(tmpdir(), 'mirage-browser-integ-'))
const config = {
  configFile: false,
  root: fileURLToPath(new URL('./', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: { external: ['@pydantic/monty'] },
  },
  optimizeDeps: {
    exclude: ['@struktoai/mirage-core', '@struktoai/mirage-browser', '@pydantic/monty'],
  },
  resolve: {
    alias: [
      {
        find: /^@struktoai\/mirage-core\/(.*)$/,
        replacement: `${root}typescript/packages/core/src/$1.ts`,
      },
      {
        find: '@struktoai/mirage-core',
        replacement: `${root}typescript/packages/core/src/index.ts`,
      },
    ],
  },
}
let browser
let server
try {
  await build(config)
  server = await preview({
    ...config,
    preview: { host: '127.0.0.1', port: 5179, strictPort: true },
  })
  const address = server.httpServer.address()
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const executablePath = process.env.CHROME_BIN ?? (existsSync(macChrome) ? macChrome : undefined)
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  })
  const page = await browser.newPage()
  page.on('pageerror', (error) => console.error(error))
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.waitForFunction(() => typeof globalThis.mirageSuite === 'function')
  const results = await page.evaluate(async () => {
    let timer
    try {
      return await Promise.race([
        globalThis.mirageSuite(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('browser shell suite exceeded 60 seconds')),
            60000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  })
  for (const result of results)
    console.log(
      `${result.error ? 'FAIL' : 'ok'} [browser] ${result.name}${result.error ? ': ' + result.error : ''}`,
    )
  if (!results.length || results.some((result) => result.error)) process.exitCode = 1
} finally {
  await browser?.close()
  await new Promise((resolve) => (server ? server.httpServer.close(resolve) : resolve()))
  await rm(outDir, { recursive: true, force: true })
}
