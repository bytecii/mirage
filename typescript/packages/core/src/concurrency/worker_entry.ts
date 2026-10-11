interface Request {
  module: string
  name: string
  args: unknown[]
}

async function execute(request: Request): Promise<{ ok: boolean; value: unknown }> {
  try {
    const module = (await import(request.module)) as Record<string, (...args: unknown[]) => unknown>
    const fn = module[request.name]
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
