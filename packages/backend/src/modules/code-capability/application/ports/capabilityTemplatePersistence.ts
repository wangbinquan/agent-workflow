// RFC-349 — closed async persistence port for capability-template use cases.

export interface CapabilityTemplateRecord {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly capability: string
  readonly scriptsJson: string
  readonly hooksJson: string
  readonly paramSchemaJson: string
  readonly paramDefaultsJson: string
  readonly agentBySlotJson: string
  readonly promptBySlotJson: string
  readonly paramsJson: string
  readonly stageContractVer: number
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly builtin: boolean
  readonly aclRevision: number
  readonly upstreamId: string | null
  readonly upstreamVersion: number | null
  readonly baseDigest: string | null
  readonly baseSnapshotJson: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CapabilityTemplatePersistence {
  list(): Promise<readonly CapabilityTemplateRecord[]>
  load(id: string): Promise<CapabilityTemplateRecord | null>
  ownerNameExists(input: {
    readonly ownerUserId: string | null
    readonly name: string
    readonly excludeId: string | null
  }): Promise<boolean>
  insert(row: CapabilityTemplateRecord): Promise<void>
  replace(row: CapabilityTemplateRecord): Promise<void>
  delete(id: string): Promise<void>
}

/** Frozen preflight result consumed by provider-owned atomic package writers. */
export interface PreparedCapabilityTemplateWrite {
  readonly row: CapabilityTemplateRecord
  readonly existing: CapabilityTemplateRecord | null
}

/** PostgreSQL/package orchestration sees only this async atomic participant. */
export interface CapabilityTemplatePackageCommit {
  commit(prepared: PreparedCapabilityTemplateWrite): Promise<void>
}
