import type {
  DigitalEmployeeWriterCutoverPersistence,
  DigitalEmployeeWriterState,
} from '../application/ports/writerCutoverPersistence'
export type {
  DigitalEmployeeWriterState,
  DigitalEmployeeWriterInstallation,
} from '../application/ports/writerCutoverPersistence'

export interface DigitalEmployeeMigrationStatus {
  readonly schemaVersion: 1
  readonly writer: DigitalEmployeeWriterState
  readonly mechanicallyAdoptable: readonly []
  readonly drainingTotal: 0
  readonly drainingTruncated: false
  readonly draining: readonly []
  readonly blockedReason: null
}
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
