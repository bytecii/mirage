import { BoundVFS } from '../bound.ts'
import { WANDB_IO } from '../../commands/builtin/wandb/io.ts'
import { WandbAccessor } from '../../accessor/wandb.ts'

import { WANDB_COMMANDS } from '../../commands/builtin/wandb/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { redactWandbConfig } from '../../core/wandb/config.ts'
import type { WandbConfig, WandbConfigRedacted } from '../../core/wandb/config.ts'

import { WANDB_OPS } from '../../ops/wandb/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import type { VFS } from '../../vfs/base.ts'
import { WANDB_PROMPT } from '../../vfs/wandb/prompt.ts'
import { VFSName } from '../../types.ts'

export interface WandbVFSState {
  type: string
  config: WandbConfigRedacted
}

export class WandbVFS extends BoundVFS<WandbAccessor> implements VFS {
  readonly kind: string = VFSName.WANDB
  readonly prompt: string = WANDB_PROMPT
  readonly config: WandbConfig
  readonly accessor: WandbAccessor

  constructor(config: WandbConfig) {
    super(WANDB_IO)
    this.config = config
    this.accessor = new WandbAccessor(config)
  }

  commands(): readonly RegisteredCommand[] {
    return WANDB_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return WANDB_OPS
  }

  override getState(): Promise<WandbVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactWandbConfig(this.config),
    })
  }
}
