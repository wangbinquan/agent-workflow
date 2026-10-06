// Native compatibility facade; all shared Doctor rules have one system-operations owner.
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import type { DoctorResult } from '@/modules/system-operations/domain/doctorDiagnostics'
import { composeDoctorApplication } from '@/modules/system-operations/composition/doctorDiagnostics'
import { createLocalDoctorDiagnosticsFactory } from '@/modules/system-operations/composition/localDoctorDiagnostics'
export type {
  CheckResult,
  DoctorResult,
  LifecycleHealthCounts,
} from '@/modules/system-operations/domain/doctorDiagnostics'
export {
  evaluateLifecycleHealth,
  evaluateGitCheck,
  evaluateSshCheck,
  evaluateMigrationsStatus,
  formatDoctor,
} from '@/modules/system-operations/domain/doctorDiagnostics'
export {
  checkPostgresqlLifecycleHealth,
  checkPostgresqlSealedCredentials,
  checkConfiguredDatabase,
  checkSealedCredentials,
  checkDbIntegrity,
  checkBackups,
  checkConfig,
} from '@/modules/system-operations/infrastructure/local/doctorDiagnostics'

export async function doctorCommand(
  selected?: ApplicationConfigurationQueries,
): Promise<DoctorResult> {
  return await composeDoctorApplication({ diagnostics: createLocalDoctorDiagnosticsFactory() }).run(
    selected,
  )
}
