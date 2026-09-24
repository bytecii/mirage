import { BoundVFS } from '../bound.ts'
import { MEM0_IO } from '../../commands/builtin/mem0/io.ts'
import { Mem0Accessor } from '../../accessor/mem0.ts'
import { redactMem0Config, type Mem0Config, type Mem0ConfigRedacted } from './config.ts'
import { MEM0_COMMANDS } from '../../commands/builtin/mem0/index.ts'

import { MEM0_OPS } from '../../ops/mem0/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { type VFS } from '../base.ts'
import { MEM0_PROMPT } from './prompt.ts'

export interface Mem0VFSState {
  type: string
  config: Mem0ConfigRedacted
}

export class Mem0VFS extends BoundVFS<Mem0Accessor> implements VFS {
  readonly kind: string = VFSName.MEM0
  readonly cachesReads: boolean = true
  // readdir and stat store the rendered JSON's byte length and read
  // serves those same bytes, so sizes are exact by construction.
  readonly sizesAlwaysKnown: boolean = true
  readonly supportsSnapshot: boolean = false
  readonly prompt: string = MEM0_PROMPT
  readonly accessor: Mem0Accessor

  private readonly config: Mem0Config

  constructor(config: Mem0Config) {
    super(MEM0_IO)
    this.config = config
    this.accessor = new Mem0Accessor(config)
  }

  commands(): readonly RegisteredCommand[] {
    return MEM0_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return MEM0_OPS
  }

  override getState(): Mem0VFSState {
    const config: Mem0ConfigRedacted = redactMem0Config(this.config)
    return { type: this.kind, config }
  }
}
