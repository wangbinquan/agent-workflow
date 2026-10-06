import { runDoctorDiagnostics } from '../application/doctorDiagnostics'
import type { DoctorDiagnosticsFactory } from '../application/ports/doctorDiagnostics'
import type { ApplicationConfigurationQueries } from '../public/queries'
import type { DoctorResult } from '../domain/doctorDiagnostics'

export interface DoctorApplication {
  run(configuration?: ApplicationConfigurationQueries): Promise<DoctorResult>
}
export function composeDoctorApplication(input: {
  readonly diagnostics: DoctorDiagnosticsFactory
}): DoctorApplication {
  return Object.freeze({
    run(configuration?: ApplicationConfigurationQueries) {
      return runDoctorDiagnostics(input.diagnostics, configuration)
    },
  })
}
