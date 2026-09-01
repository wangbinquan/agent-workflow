// RFC-349 — closed read/atomic-write port for capability-template upstream sync.

export interface TemplateUpstreamRecord {
  id: string
  name: string
  description: string | null
  capability: string
  scriptsJson: string
  hooksJson: string
  paramSchemaJson: string
  paramDefaultsJson: string
  agentBySlotJson: string
  promptBySlotJson: string
  paramsJson: string
  stageContractVer: number
  upstreamId: string | null
  upstreamVersion: number | null
  baseDigest: string | null
  baseSnapshotJson: string | null
  updatedAt: number
}

export interface TemplateUpstreamSnapshot {
  readonly local: TemplateUpstreamRecord
  readonly upstream: TemplateUpstreamRecord | null
}

export interface TemplateUpstreamMergePatch {
  readonly description: string | null
  readonly scriptsJson: string
  readonly hooksJson: string
  readonly paramSchemaJson: string
  readonly paramDefaultsJson: string
  readonly agentBySlotJson: string
  readonly promptBySlotJson: string
  readonly paramsJson: string
  readonly stageContractVer: number
  readonly upstreamVersion: number | null
  readonly baseDigest: string
  readonly baseSnapshotJson: string
  readonly updatedAt: number
}

export type TemplateUpstreamPersistenceResult =
  | { readonly ok: false; readonly code: 'no-upstream' | 'upstream-gone' }
  | {
      readonly ok: true
      readonly applied: readonly string[]
      readonly keptLocal: readonly string[]
      readonly stillConflicted: readonly string[]
    }

export interface TemplateUpstreamAtomicDecision {
  readonly result: TemplateUpstreamPersistenceResult
  readonly patch: TemplateUpstreamMergePatch | null
}

export interface TemplateUpstreamPersistence {
  load(templateId: string): Promise<TemplateUpstreamRecord | null>
  decideAndPersist(
    templateId: string,
    decide: (snapshot: TemplateUpstreamSnapshot) => TemplateUpstreamAtomicDecision,
  ): Promise<TemplateUpstreamPersistenceResult | null>
}
