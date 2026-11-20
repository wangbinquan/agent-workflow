// RFC-516 — the observer program used when the deployment supplies none: every run fails with the original error.
import type { EventObserverProgramPort } from '../composition/required-ports'

export function createUnavailableEventObserverProgram(): EventObserverProgramPort {
  return {
    async run(input) {
      throw new Error(
        `observer program unavailable: ${input.source.observerProgramRef?.id ?? input.source.sourceRef.id}`,
      )
    },
  }
}
