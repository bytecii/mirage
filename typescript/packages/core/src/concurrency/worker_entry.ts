const computations: Record<string, () => Promise<unknown>> = {
  scanMany: async () => (await import('../utils/regex_scan.ts')).scanMany,
  scan: async () => (await import('../utils/regex_scan.ts')).scan,
  jqRunTexts: async () => (await import('../core/jq/eval.ts')).jqRunTexts,
  sortLines: async () => (await import('../commands/builtin/sort_keys.ts')).sortLines,
  mergeLines: async () => (await import('../commands/builtin/sort_keys.ts')).mergeLines,
  edScript: async () => (await import('../commands/builtin/diff_format.ts')).edScript,
  unifiedDiff: async () => (await import('../commands/builtin/diff_format.ts')).unifiedDiff,
  normalDiff: async () => (await import('../commands/builtin/diff_format.ts')).normalDiff,
}

interface Request {
  name: string
  args: unknown[]
}

async function execute(request: Request): Promise<{ ok: boolean; value: unknown }> {
  try {
    const load = computations[request.name]
    const fn = (await load?.()) as ((...args: unknown[]) => unknown) | undefined
    if (fn === undefined) throw new Error(`No computation named ${request.name}`)
    return { ok: true, value: await fn(...request.args) }
  } catch (error) {
    return { ok: false, value: error }
  }
}

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node
if (node !== undefined) {
  const { parentPort } = await import('node:worker_threads')
  parentPort?.on('message', (request: Request) => {
    void execute(request).then((result) => {
      parentPort.postMessage(result)
    })
  })
} else {
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent<Request>) => void
    postMessage(data: unknown): void
  }
  scope.onmessage = (event) => {
    void execute(event.data).then((result) => {
      scope.postMessage(result)
    })
  }
}

export {}
