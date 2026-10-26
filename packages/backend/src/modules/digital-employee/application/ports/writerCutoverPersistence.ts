export interface DigitalEmployeeWriterInstallation {
  readonly activeGeneration: number
  readonly updatedAt: number
}
export interface DigitalEmployeeWriterState extends DigitalEmployeeWriterInstallation {
  readonly mode: 'os-active'
  readonly legacyAdmissionsEnabled: false
  readonly legacyOpenMissionCount: 0
}

/** Read-only installation/activation receipt projection; no retired writer row. */
export interface DigitalEmployeeWriterCutoverPersistence {
  read(): Promise<DigitalEmployeeWriterState>
}
