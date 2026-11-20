// RFC-379: tests that need a ready Event Center explicitly initialize its passive composition.
import type { EventObserverProgramPort } from '../../src/modules/event-center/composition/required-ports'
import {
  composeEventCenter as compose,
  createLocalCustomObserverProgramFactory,
} from '../../src/modules/event-center/composition'
export async function composeEventCenter(...args: Parameters<typeof compose>) {
  const module = await compose(...args)
  await module.initialize()
  return module
}

/**
 * RFC-516 placed this null observer in event-center's application for the composition's fallback; RFC-522 removed the fallback,
 * so only tests use it: every run fails with the original error.
 */
export function createUnavailableEventObserverProgram(): EventObserverProgramPort {
  return {
    async run(input) {
      throw new Error(
        `observer program unavailable: ${input.source.observerProgramRef?.id ?? input.source.sourceRef.id}`,
      )
    },
  }
}

/**
 * RFC-522 — the two selections composition used to pick when a caller gave none: an observer program that refuses every run
 * and the local custom observer program factory. Tests that do not exercise observation spread these.
 */
export function standaloneEventCenterSelections() {
  return {
    observer: createUnavailableEventObserverProgram(),
    customObserverPrograms: createLocalCustomObserverProgramFactory(),
  }
}
