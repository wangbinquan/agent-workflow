import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'
import type { IntentJournalArtifact } from '../../domain/journalArtifacts'

export type IntentSkillArtifact = Extract<
  IntentApplyArtifact,
  { kind: 'skill-stage' | 'skill-version-stage' }
>

/** AW selects and verifies committed metadata before asking storage to publish. */
export interface IntentSkillArtifactPublication {
  readonly artifact: IntentSkillArtifact
  readonly version: number
  readonly managedPath: string
  readonly disposition: 'current' | 'superseded'
  readonly filesPath: string
  readonly contentHash: string
}

/** Storage effects only; Intent retains journal decoding, commit and retry rules. */
export interface IntentArtifactContentPort {
  pluginExists(reference: string): boolean | Promise<boolean>
  discardPlugin(reference: string): void | Promise<void>
  publishSkill(publication: IntentSkillArtifactPublication): void | Promise<void>
  discardSkill(input: {
    readonly artifact: IntentSkillArtifact
    readonly version: number
  }): void | Promise<void>
  discardLegacy(artifact: IntentJournalArtifact): void | Promise<void>
}
