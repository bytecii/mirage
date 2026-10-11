import { abortable, makeAbortError } from '../utils/abort.ts'

interface Port {
  post(data: unknown): void
  close(): Promise<void>
}

interface Reply {
  ok: boolean
  value: unknown
}

async function createPort(
  done: (reply: Reply) => void,
  failed: (error: Error) => void,
): Promise<Port> {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node
  if (node !== undefined) {
    const { Worker: NodeWorker } = await import('node:worker_threads')
    const url = new URL(
      import.meta.url.endsWith('.ts') ? './worker_entry.ts' : './worker_entry.js',
      import.meta.url,
    )
    const worker = new NodeWorker(url, {
      execArgv: url.pathname.endsWith('.ts')
        ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning']
        : [],
    })
    worker.on('message', done)
    worker.on('error', failed)
    worker.on('exit', (code: number) => {
      failed(new Error(`computation worker exited (${String(code)})`))
    })
    return {
      post: (data) => {
        worker.postMessage(data)
      },
      close: async () => {
        await worker.terminate()
      },
    }
  }
  const { Worker } = globalThis
  const worker = new Worker(new URL('./worker_entry.js', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (event: MessageEvent<Reply>) => {
    done(event.data)
  }
  worker.onerror = (event) => {
    failed(new Error(event.message))
  }
  return {
    post: (data) => {
      worker.postMessage(data)
    },
    close: () => {
      worker.terminate()
      return Promise.resolve()
    },
  }
}

/** An invocation-owned worker for computations that cannot yield inside their engine. */
export class Worker {
  private port: Promise<Port> | undefined
  // The calls the live port still owes, oldest first.
  private waiting: { resolve: (reply: Reply) => void; reject: (error: unknown) => void }[] = []

  /** Calls may overlap; the worker answers them in the order they were made. */
  async call<T>(name: string, args: readonly unknown[], signal?: AbortSignal): Promise<T> {
    try {
      signal?.throwIfAborted()
      const port = (this.port ??= this.open())
      const waiting = this.waiting
      const ready = await abortable(port, signal)
      if (port !== this.port) throw makeAbortError(signal)
      const reply = new Promise<Reply>((resolve, reject) => {
        waiting.push({ resolve, reject })
      })
      ready.post({ name, args })
      const { ok, value } = await abortable(reply, signal)
      if (!ok)
        throw value instanceof Error ? value : new Error('Computation failed', { cause: value })
      return value as T
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    const port = this.port
    this.port = undefined
    for (const waiter of this.waiting.splice(0)) waiter.reject(makeAbortError())
    await (await port)?.close()
  }

  private open(): Promise<Port> {
    const waiting: typeof this.waiting = []
    this.waiting = waiting
    return createPort(
      (reply) => waiting.shift()?.resolve(reply),
      (error) => {
        for (const waiter of waiting.splice(0)) waiter.reject(error)
      },
    )
  }
}

export async function runIsolated<T>(
  name: string,
  args: readonly unknown[],
  signal?: AbortSignal,
): Promise<T> {
  const worker = new Worker()
  try {
    return await worker.call<T>(name, args, signal)
  } finally {
    await worker.close()
  }
}
