import type { CustomObserverProgramFactory } from '../application/ports/customObserverProgram'
import { createLocalCustomObserverProgramFactory } from '../infrastructure/local/customObserverProgram'

export { createLocalCustomObserverProgramFactory } from '../infrastructure/local/customObserverProgram'
export function selectLocalCustomObserverProgramFactory(
  selected: CustomObserverProgramFactory | undefined,
): CustomObserverProgramFactory {
  return selected === undefined ? createLocalCustomObserverProgramFactory() : selected
}
