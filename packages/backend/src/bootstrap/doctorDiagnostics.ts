// RFC-395 II-b O3 — native Doctor opens its usual handles and receives Task's required SPI.
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { composeDoctorApplication } from '@/modules/system-operations/composition/doctorDiagnostics'
import { createLocalDoctorDiagnosticsFactory as createDiagnosticsFactory } from '@/modules/system-operations/composition/localDoctorDiagnostics'
import { composeSystemOperationsTaskPorts } from '@/modules/task-execution/composition'

export function createLocalDoctorDiagnosticsFactory(contract: LogicalSchemaContract) {
  return createDiagnosticsFactory(contract, composeSystemOperationsTaskPorts())
}

// The native command shares main.ts's explicit owner-adapter binding.
export async function doctorCommand(
  contract: LogicalSchemaContract,
  selected?: ApplicationConfigurationQueries,
) {
  return await composeDoctorApplication({
    diagnostics: createLocalDoctorDiagnosticsFactory(contract),
  }).run(selected)
}
