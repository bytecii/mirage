import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const modules = {
  pyodide: ['python/execution.py'],
  quickjs: ['js/quickjs/execution.js', 'js/quickjs/filesystem.js'],
}
const output = new URL('../src/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
for (const [name, paths] of Object.entries(modules)) {
  const source = paths
    .map((path) => readFileSync(new URL(`../src/runtime/${path}`, import.meta.url), 'utf8'))
    .join('\n')
  writeFileSync(new URL(`${name}.ts`, output), `export default ${JSON.stringify(source)}\n`)
}
