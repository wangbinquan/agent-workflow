// RFC-370 compatibility entry; policy and effects each have one implementation.
import { composeCustomEventObserverProgram } from '../composition/customObserverProgram'
import { selectLocalCustomObserverProgramFactory } from '../composition/localCustomObserverProgram'
import type { CustomEventSourceStorePort } from '../application/ports/customEventSourceStore'
import type { CustomObserverProgramFactory } from '../application/ports/customObserverProgram'
import type { CustomEventObserverProgramPort } from '../composition/required-ports'

export function createCustomEventObserverProgram(input: {
  readonly store: CustomEventSourceStorePort
  readonly now?: () => number
  readonly programs?: CustomObserverProgramFactory
}): CustomEventObserverProgramPort {
  const now = input.now ?? Date.now
  return composeCustomEventObserverProgram({
    get store() {
      return input.store
    },
    now,
    programs: selectLocalCustomObserverProgramFactory(input.programs),
  })
}
