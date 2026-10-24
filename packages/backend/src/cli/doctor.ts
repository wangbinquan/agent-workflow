// Native compatibility exports; Doctor assembly belongs to bootstrap.
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
