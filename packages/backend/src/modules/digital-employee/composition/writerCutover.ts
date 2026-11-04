import type {
  DigitalEmployeeMigrationStatus,
  DigitalEmployeeWriterCutoverPersistence,
  DigitalEmployeeWriterState,
} from '../application/ports/writerCutoverPersistence'
export type {
  DigitalEmployeeMigrationStatus,
  DigitalEmployeeWriterState,
  DigitalEmployeeWriterInstallation,
} from '../application/ports/writerCutoverPersistence'
export interface DigitalEmployeeWriterCutoverOperations {
  read(): Promise<DigitalEmployeeWriterState>
  analyze(): Promise<DigitalEmployeeMigrationStatus>
}
export function createDigitalEmployeeWriterCutoverOperations(
  persistence: DigitalEmployeeWriterCutoverPersistence,
): DigitalEmployeeWriterCutoverOperations {
  return Object.freeze({
    read: () => persistence.read(),
    async analyze(): Promise<DigitalEmployeeMigrationStatus> {
      return {
        schemaVersion: 1,
        writer: await persistence.read(),
        mechanicallyAdoptable: [],
        drainingTotal: 0,
        drainingTruncated: false,
        draining: [],
        blockedReason: null,
      }
    },
  })
}
