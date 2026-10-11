import { KeyLock } from '../cache/lock.ts'
import { abortable, makeAbortError } from '../utils/abort.ts'

interface Port {
  post(data: unknown): void
  close(): Promise<void>
}

async function createPort(
  done: (data: { ok: boolean; value: unknown }) => void,
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
  const worker = new globalThis.Worker(new URL('./worker_entry.js', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (event: MessageEvent<{ ok: boolean; value: unknown }>) => {
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
  private readonly lock = new KeyLock()
  private port: Port | undefined
  private done: ((data: { ok: boolean; value: unknown }) => void) | undefined
  private failed: ((error: Error) => void) | undefined

  async call<T>(
    module: URL,
    name: string,
    args: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<T> {
    return this.lock.withLock('call', () => this.execute<T>(module, name, args, signal))
  }

  private async execute<T>(
    module: URL,
    name: string,
    args: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted()
      this.port ??= await createPort(
        (data) => this.done?.(data),
        (error) => this.failed?.(error),
      )
      if (signal?.aborted === true) throw makeAbortError(signal)
      const result = new Promise<T>((resolve, reject) => {
        this.done = (data) => {
          if (data.ok) resolve(data.value as T)
          else
            reject(
              data.value instanceof Error
                ? data.value
                : new Error('Computation failed', { cause: data.value }),
            )
        }
        this.failed = reject
      })
      this.port.post({ module: module.href, name, args })
      return await abortable(result, signal)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    const port = this.port
    this.port = undefined
    this.failed?.(makeAbortError())
    this.done = undefined
    this.failed = undefined
    await port?.close()
  }
}

export async function runIsolated<T>(
  module: URL,
  name: string,
  args: readonly unknown[],
  signal?: AbortSignal,
): Promise<T> {
  const worker = new Worker()
  try {
    return await worker.call<T>(module, name, args, signal)
  } finally {
    await worker.close()
  }
}
