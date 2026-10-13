import type { HostExecutionAvailabilityQueries } from '../application/ports/hostExecutionAuthority'
import type { HostExecutionStatusQuery } from '../public/queries'

export function composeHostExecutionStatusQuery(input: {
  readonly mode: 'execution' | 'resource-only'
  readonly queries: HostExecutionAvailabilityQueries
}): HostExecutionStatusQuery {
  const mode = input.mode,
    read = input.queries.snapshot.bind(input.queries)
  return Object.freeze({
    readCurrent() {
      const status = read()
      return { mode, status: { ...status, readyGroups: [...status.readyGroups] } }
    },
  })
}
