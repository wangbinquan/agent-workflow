import { createCustomEventObserverProgram } from '../application/customObserverProgram'
import type { CustomEventSourceStorePort } from '../application/ports/customEventSourceStore'
import type { CustomObserverProgramFactory } from '../application/ports/customObserverProgram'

export function composeCustomEventObserverProgram(input: {
  readonly store: CustomEventSourceStorePort
  readonly programs: CustomObserverProgramFactory
  readonly now?: () => number
}) {
  return createCustomEventObserverProgram(input)
}
export type { CustomObserverProgramFactory }
