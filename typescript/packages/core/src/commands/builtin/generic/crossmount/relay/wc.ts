import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import { type PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { wcGeneric } from '../../wc.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { crossOpts, flatten, fileStreamOp } from '../utils.ts'

export async function runWc(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  const reads = new IOResult()
  const [body, io] = (await wcGeneric(
    flatten(scopes),
    [],
    { ...crossOpts(flagKwargs), stdin },
    fileStreamOp(dispatch, reads),
  )) ?? [null, new IOResult()]
  return [body, await reads.merge(io)]
}
