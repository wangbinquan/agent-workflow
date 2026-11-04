export interface DigitalEmployeeWriterInstallation {
  readonly activeGeneration: number
  readonly updatedAt: number
}
export interface DigitalEmployeeWriterState extends DigitalEmployeeWriterInstallation {
  readonly mode: 'os-active'
  readonly legacyAdmissionsEnabled: false
  readonly legacyOpenMissionCount: 0
}

/**
 * The migration report the HTTP binding serves. RFC-436 moved it here from
 * `composition/writerCutover.ts` so the route-facing handle in
 * `application/ports` does not import composition.
 */
export interface DigitalEmployeeMigrationStatus {
  readonly schemaVersion: 1
  readonly writer: DigitalEmployeeWriterState
  readonly mechanicallyAdoptable: readonly []
  readonly drainingTotal: 0
  readonly drainingTruncated: false
  readonly draining: readonly []
  readonly blockedReason: null
}

/** Read-only installation/activation receipt projection; no retired writer row. */
export interface DigitalEmployeeWriterCutoverPersistence {
  read(): Promise<DigitalEmployeeWriterState>
}
