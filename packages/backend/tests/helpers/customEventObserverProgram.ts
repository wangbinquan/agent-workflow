// RFC-370 compatibility entry; policy and effects each have one implementation.
// RFC-522: the program factory is required and the entry calls the application directly (no composition import).
// RFC-584: moved verbatim from event-center infrastructure/customEventObserverProgram.ts — only contract tests use it; no production entry reaches it.
import { createCustomEventObserverProgram as createObserverProgram } from '@/modules/event-center/application/customObserverProgram'
import type { CustomEventSourceStorePort } from '@/modules/event-center/application/ports/customEventSourceStore'
import type { CustomObserverProgramFactory } from '@/modules/event-center/application/ports/customObserverProgram'

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
