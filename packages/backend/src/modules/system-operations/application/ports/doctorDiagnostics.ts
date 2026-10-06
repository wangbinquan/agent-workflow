import type { ApplicationConfigurationQueries } from '../../public/queries'
import type { CheckResult } from '../../domain/doctorDiagnostics'

// Only the selected native/CS pairing interprets a runtime configuration reference.
export type DoctorRuntimeSelectionRef = unknown
export interface DoctorRuntimeProbe {
  readonly binary: string
  readonly version: string | null
  readonly ran?: boolean
}
type MaybeAsync<T> = T | Promise<T>
export interface DoctorDiagnosticsFamily {
  loadRuntimeConfiguration(): MaybeAsync<DoctorRuntimeSelectionRef>
  probeRuntime(selection: DoctorRuntimeSelectionRef): MaybeAsync<DoctorRuntimeProbe>
  git(): MaybeAsync<CheckResult>
  ssh(): MaybeAsync<CheckResult>
  home(): MaybeAsync<CheckResult>
  configuration(): MaybeAsync<CheckResult>
  installation(): MaybeAsync<CheckResult>
  migrations(): MaybeAsync<CheckResult>
  backups(): MaybeAsync<CheckResult>
  database(): MaybeAsync<readonly CheckResult[]>
}
export interface DoctorDiagnosticsFactory {
  create(input: {
    readonly configuration?: ApplicationConfigurationQueries
  }): DoctorDiagnosticsFamily
}
