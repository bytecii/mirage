import type { Accessor } from '../accessor/base.ts'
import type { CommandIO } from '../commands/builtin/generic_bind/adapter.ts'
import { streamFromBytes } from '../commands/builtin/utils/wrap.ts'
import { isEnoent } from '../utils/errors.ts'
import type { NativeReadOps, ReadOps, WriteOps, SearchOps } from './types.ts'

export interface VFSAdapterOptions<A extends Accessor = Accessor> {
  read: ReadOps<A>
  native?: NativeReadOps<A>
  writes?: WriteOps<A>
  search?: SearchOps<A>
  local?: boolean
  isMounted?: CommandIO<A>['isMounted']
  maxGlobMatches?: number
  maxDuEntries?: number
}

/** Compose capabilities into one table for commands and filesystem ops. */
export class VFSAdapter<A extends Accessor = Accessor> {
  constructor(readonly options: VFSAdapterOptions<A>) {}

  toCommandIO(): CommandIO<A> {
    const { read, native, writes, ...settings } = this.options
    return {
      ...read,
      readStream: (a, p, i) => streamFromBytes(read.readBytes, a, p, i),
      exists: async (a, p) => {
        try {
          await read.stat(a, p)
          return true
        } catch (error) {
          if (isEnoent(error)) return false
          throw error
        }
      },
      local: false,
      isMounted: () => true,
      ...settings,
      ...native,
      ...writes,
    }
  }
}
