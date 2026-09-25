import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import { FileType, type PathSpec } from '../../../../../types.ts'
import { eisdir } from '../../../../../utils/errors.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { wcGeneric } from '../../wc.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { crossOpts, flatten, statOp, streamOp } from '../utils.ts'

export async function runWc(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  const stat = statOp(dispatch)
  const stream = streamOp(dispatch)
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    if ((await stat(path)).type === FileType.DIRECTORY) throw eisdir(path)
    yield* stream(path)
  }
  return (
    (await wcGeneric(flatten(scopes), [], { ...crossOpts(flagKwargs), stdin }, read)) ?? [
      null,
      new IOResult(),
    ]
  )
}
