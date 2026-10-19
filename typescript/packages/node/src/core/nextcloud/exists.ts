import { makeExists } from '@struktoai/mirage-core/core/object_store/exists'
import { stat } from './stat.ts'

export const exists = makeExists(stat)
