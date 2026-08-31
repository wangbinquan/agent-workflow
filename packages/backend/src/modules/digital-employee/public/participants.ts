declare const digitalEmployeeIntegrationTriggerParticipantBrand: unique symbol

/**
 * Owner-native read participant used by the resource-catalog integration-trigger adapter.
 *
 * Identity is loaded separately from content so the consumer can preserve the
 * ACL-before-content invariant. The handle is minted only by the Digital
 * Employee application factory and carries no database-shaped values.
 */
export interface DigitalEmployeeIntegrationTriggerParticipant {
  readonly [digitalEmployeeIntegrationTriggerParticipantBrand]: 'digital-employee-integration-trigger-participant'

  loadIdentity(employeeDefinitionId: string): Readonly<{
    readonly id: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly archivedAt: number | null
    readonly currentRevision: number | null
    readonly typeId: string
    readonly typeRevision: number
  }> | null

  loadCurrentSnapshot(employeeDefinitionId: string):
    | Readonly<{ readonly kind: 'revision-unavailable' }>
    | Readonly<{ readonly kind: 'intake-unavailable' }>
    | Readonly<{
        readonly kind: 'ready'
        readonly employeeDefinitionId: string
        readonly currentRevision: number
        readonly typeId: string
        readonly typeRevision: number
        readonly intake: Readonly<{
          readonly acceptedKinds: readonly ('body' | 'files' | 'body-and-files' | 'external-id')[]
          readonly targetFields: readonly Readonly<{
            readonly fieldRef: string
            readonly required: boolean
          }>[]
        }>
      }>
}
