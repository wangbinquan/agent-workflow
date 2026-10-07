import type { ProviderNeutralDatabase } from '@/db/query'
import { createNativeUsageInvocationPersistence } from '@/modules/task-execution/public/participants'
import type { NativeUsageAdmission } from '@/modules/task-execution/public/types'
import type { NativeUsageInvocationPersistence } from '@/modules/task-execution/public/participants'
import type { OriginalReportDatabaseBinding } from './reportSnapshot'
import { nativeUsageBaselineRead } from './nativeUsageBaselineRead'

/** Selection never changes the original authority, execution claim, price or source database. */
export function selectedNativeUsageInvocationPersistence(
  db: ProviderNeutralDatabase,
  input: {
    readonly binding: OriginalReportDatabaseBinding
    readonly admissions: readonly NativeUsageAdmission[]
    readonly postgresqlPoolMax?: number
  },
): NativeUsageInvocationPersistence | undefined {
  if (input.admissions.length === 0) return undefined
  return createNativeUsageInvocationPersistence(db, {
    rootSets: true,
    admissions: input.admissions,
    baselineRead: nativeUsageBaselineRead(input.binding, input.postgresqlPoolMax),
  })
}
