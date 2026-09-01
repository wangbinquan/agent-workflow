import type {
  DigitalEmployeeWriterCutoverPersistence,
  DigitalEmployeeWriterState,
} from '../application/ports/writerCutoverPersistence'

export type { DigitalEmployeeWriterState }

const MIGRATION_REPORT_LIMIT = 100

export interface DigitalEmployeeMigrationStatus {
  readonly schemaVersion: 1
  readonly writer: DigitalEmployeeWriterState
  readonly mechanicallyAdoptable: readonly []
  readonly drainingTotal: number
  readonly drainingTruncated: boolean
  readonly draining: ReadonlyArray<{
    readonly missionId: string
    readonly status: string
    readonly activeMrClaimCount: number
    readonly childLinkCount: number
    readonly pendingApprovalCount: number
  }>
  readonly blockedReason: string | null
}

export interface DigitalEmployeeWriterCutoverOperations {
  read(): Promise<DigitalEmployeeWriterState>
  activate(options?: {
    readonly legacyAdmissionsEnabled?: boolean
    readonly now?: number
  }): Promise<DigitalEmployeeWriterState>
  refresh(now?: number): Promise<DigitalEmployeeWriterState>
  analyze(): Promise<DigitalEmployeeMigrationStatus>
}

export function createDigitalEmployeeWriterCutoverOperations(
  persistence: DigitalEmployeeWriterCutoverPersistence,
): DigitalEmployeeWriterCutoverOperations {
  return Object.freeze({
    read: () => persistence.read(),
    activate: (
      options: {
        readonly legacyAdmissionsEnabled?: boolean
        readonly now?: number
      } = {},
    ) =>
      persistence.activate({
        now: options.now ?? Date.now(),
        legacyAdmissionsEnabled: options.legacyAdmissionsEnabled ?? false,
      }),
    refresh: (now = Date.now()) => persistence.refresh(now),
    async analyze() {
      const snapshot = await persistence.migrationSnapshot(MIGRATION_REPORT_LIMIT)
      return {
        schemaVersion: 1 as const,
        writer: snapshot.writer,
        mechanicallyAdoptable: [] as const,
        drainingTotal: snapshot.writer.legacyOpenMissionCount,
        drainingTruncated: snapshot.drain.truncated,
        draining: snapshot.drain.entries,
        blockedReason:
          snapshot.drain.entries.length === 0
            ? null
            : 'active legacy Missions retain their existing writer claims until terminal; they are never concurrently adopted by the OS',
      }
    },
  })
}
