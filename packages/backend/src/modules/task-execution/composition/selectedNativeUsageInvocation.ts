import type { ProviderNeutralDatabase } from '@/db/query'
import { createNativeUsageInvocationPersistence } from './nativeUsageInvocation'
import type { NativeUsageAdmission } from '../application/ports/nativeUsageAdmission'
import type { NativeUsageInvocationPersistence } from '../application/ports/nativeUsageInvocation'
import type { OriginalReportDatabaseBinding } from '@/platform/persistence/reportSnapshot'
import { nativeUsageBaselineRead } from '@/platform/persistence/nativeUsageBaselineRead'

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
