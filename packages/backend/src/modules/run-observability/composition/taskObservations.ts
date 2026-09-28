import type { ProviderNeutralDatabase } from '@/db/query'
import { createTaskObservationQueries } from '../application/taskObservations'
import { createTaskObservationSnapshot } from '../infrastructure/taskObservationSnapshot'
import type { ObservationTaskSource } from '../ports/taskObservations'
import type { ObservationTaskQueries } from '../public/queries'

export function composeTaskObservations(input: {
  readonly db: ProviderNeutralDatabase
  readonly taskSource: (connection: ProviderNeutralDatabase) => ObservationTaskSource
  readonly now?: () => number
}): ObservationTaskQueries {
  return createTaskObservationQueries({
    snapshot: createTaskObservationSnapshot(input),
    now: input.now ?? Date.now,
  })
}
