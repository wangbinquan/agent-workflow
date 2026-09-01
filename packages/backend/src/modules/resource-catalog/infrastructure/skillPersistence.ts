import type { Skill, SkillVersion, SkillVersionSource } from '@agent-workflow/shared'

export interface SkillPersistenceRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly managedPath: string | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly schemaVersion: number
  readonly contentVersion: number
  readonly aclRevision: number
  readonly metaRevision: number
  readonly reservationState: 'reserving' | 'ready'
  readonly versionState:
    | 'legacy-unbackfilled'
    | 'snapshot-unverified'
    | 'snapshot-authoritative'
    | 'quarantined'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SkillVersionPersistenceRow {
  readonly id: string
  readonly skillId: string
  readonly versionIndex: number
  readonly filesPath: string
  readonly source: SkillVersionSource
  readonly summary: string | null
  readonly fusionId: string | null
  readonly restoredFromVersion: number | null
  readonly authorUserId: string | null
  readonly contentHash: string | null
  readonly createdAt: number
}

export function skillFromPersistenceRow(row: SkillPersistenceRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
    sourceKind: 'managed',
    ...(row.managedPath === null ? {} : { managedPath: row.managedPath }),
    schemaVersion: row.schemaVersion,
    contentVersion: row.contentVersion,
    metaRevision: row.metaRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function skillVersionFromPersistenceRow(
  row: SkillVersionPersistenceRow,
  skillName: string,
): SkillVersion {
  return {
    id: row.id,
    skillName,
    versionIndex: row.versionIndex,
    source: row.source,
    summary: row.summary,
    fusionId: row.fusionId,
    restoredFromVersion: row.restoredFromVersion,
    authorUserId: row.authorUserId,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
  }
}
