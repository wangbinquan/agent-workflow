// RFC-349 — provider-owned facts behind the repository capability matrix.
//
// The application still owns readiness and repair-action derivation. A
// provider adapter only returns the persisted cell together with the facts it
// observed, so PostgreSQL cannot grow a second interpretation of "ready".

import type { ReadinessInput } from '@/modules/code-capability/domain/templateLayers'

export interface CapabilityMatrixReadRow {
  readonly repoId: string
  readonly capability: string
  readonly templateId: string | null
  readonly enabled: boolean
  readonly facts: ReadinessInput
}

export interface CapabilityMatrixReadPort {
  loadForRepo(repoId: string): Promise<readonly CapabilityMatrixReadRow[]>
}
