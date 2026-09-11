import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/runtime/python/guest.py', import.meta.url), 'utf8')
const output = new URL('../src/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
writeFileSync(new URL('pyodide.ts', output), `export default ${JSON.stringify(source)}\n`)
