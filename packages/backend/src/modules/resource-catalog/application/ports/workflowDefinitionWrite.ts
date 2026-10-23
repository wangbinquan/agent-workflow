/** Canonical definition bytes stay authored bytes; II-b indexes this revision in the same write. */
export interface WorkflowDefinitionRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly definition: string
  readonly version: number
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly aclRevision: number
  readonly builtin: boolean
  readonly schemaVersion: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface WorkflowDefinitionWriteParticipant {
  insert(
    record: Omit<WorkflowDefinitionRecord, 'schemaVersion'> & { readonly schemaVersion?: number },
  ): Promise<WorkflowDefinitionRecord[]>
  update(input: {
    readonly id: string
    readonly set: Pick<WorkflowDefinitionRecord, 'definition' | 'version'> &
      Partial<Omit<WorkflowDefinitionRecord, 'id' | 'definition' | 'version'>>
    readonly expectedVersion?: number
    readonly expectedAclRevision?: number
    readonly ownerUserId?: string
    readonly builtin?: boolean
  }): Promise<WorkflowDefinitionRecord[]>
}
