import { eisdir } from '../../../../../utils/errors.ts'
import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import { FileType, type PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { sortGeneric } from '../../sort.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { crossOpts, flatten, readBytesOp, statOp } from '../utils.ts'

export async function runSort(
  scopes: PathSpec[],
  bag: Record<string, FlagValue>,
  dispatch: DispatchFn,
  stdin: ByteSource | null,
): Promise<CrossResult> {
  const write = async (path: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('write', path, [data])
  }
  const read = readBytesOp(dispatch)
  const stat = statOp(dispatch)
  async function* stream(path: PathSpec): AsyncIterable<Uint8Array> {
    if ((await stat(path)).type === FileType.DIRECTORY) throw eisdir(path)
    yield await read(path)
  }
  const result = await sortGeneric(flatten(scopes), { ...crossOpts(bag), stdin }, stream, write)
  return result ?? [null, new IOResult()]
}
