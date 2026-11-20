// RFC-370 compatibility entry; policy and effects each have one implementation.
// RFC-522: the program factory is required and the entry calls the application directly (no composition import).
import { createCustomEventObserverProgram as createObserverProgram } from '../application/customObserverProgram'
import type { CustomEventSourceStorePort } from '../application/ports/customEventSourceStore'
import type { CustomObserverProgramFactory } from '../application/ports/customObserverProgram'

export function createCustomEventObserverProgram(input: {
  readonly store: CustomEventSourceStorePort
  readonly now?: () => number
  readonly programs: CustomObserverProgramFactory
}) {
  const now = input.now ?? Date.now
  return createObserverProgram({
    get store() {
      return input.store
    },
    now,
    programs: input.programs,
  })
}
