import { uuid7 } from '../utils/ids.ts'

export function newExecutionId(): string {
  return `exec_${uuid7()}`
}
