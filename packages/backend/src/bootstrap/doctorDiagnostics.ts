// RFC-395 II-b O3 — native Doctor opens its usual handles and receives Task's required SPI.
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { composeDoctorApplication } from '@/modules/system-operations/composition/doctorDiagnostics'
import { createLocalDoctorDiagnosticsFactory as createDiagnosticsFactory } from '@/modules/system-operations/composition/localDoctorDiagnostics'
import { composeSystemOperationsTaskPorts } from '@/modules/task-execution/composition'
import { composeDefaultRuntimeBinaryProbe } from '@/modules/runtime-management/composition/defaultRuntimeBinaryProbe'

export function createLocalDoctorDiagnosticsFactory(contract: LogicalSchemaContract) {
  // RFC-487: runtime-management's default-binary probe fills system-operations' own probe port.
  return createDiagnosticsFactory(
    contract,
    composeSystemOperationsTaskPorts(),
    composeDefaultRuntimeBinaryProbe(),
  )
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
