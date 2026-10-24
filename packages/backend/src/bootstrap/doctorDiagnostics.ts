// RFC-395 II-b O3 — native Doctor opens its usual handles and receives Task's required SPI.
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { createLocalDoctorDiagnosticsFactory as createDiagnosticsFactory } from '@/modules/system-operations/composition/localDoctorDiagnostics'
import { composeSystemOperationsTaskPorts } from '@/modules/task-execution/composition'

export function createLocalDoctorDiagnosticsFactory(contract: LogicalSchemaContract) {
  return createDiagnosticsFactory(contract, composeSystemOperationsTaskPorts())
}
