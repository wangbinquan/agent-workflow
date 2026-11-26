// RFC-495 (RFC-294 S10 step 2): the platform work-item use cases live in
// application/employeePlatformWorkItems.ts. This file only assembles them: it checks the workspace effects (RFC-599: the
// caller states them and the baseline effects — the daemon gives the deployment's, tests the local implementations),
// takes the evidence store the caller selected (RFC-524: required), binds the business-tree digest and the
// baseline file reader to their local implementations, and supplies the default clock.
import type { AutomationWorkspaceEffectsFactory } from '../application/ports/automationWorkspaceEffects'
import type { RepositoryBaselineEffectsFactory } from '../application/ports/repositoryBaselineEffects'
import type { EvidenceArtifactPort } from '../application/ports/evidenceArtifacts'
import {
  createDevelopmentEmployeePlatformWorkItems,
  type DevelopmentEmployeePlatformWorkItemsInput,
} from '../application/employeePlatformWorkItems'
import { selectedAutomationWorkspaceEffects } from '../infrastructure/automationWorkspaceEffects'
import { createEmployeePlatformWorkItemPersistence } from '../infrastructure/employeePlatformWorkItemPersistence'
import { createGitBaselineReader } from '../infrastructure/gitBaselineReader'
import { businessTreeSnapshot, businessTreeSnapshotDigest } from '../application/workspaceValidator'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export interface DevelopmentEmployeePlatformWorkItemsCompositionInput extends Omit<
  DevelopmentEmployeePlatformWorkItemsInput,
  | 'automationWorkspaceEffects'
  | 'baselineFileReader'
  | 'evidenceStore'
  | 'businessTreeDigest'
  | 'now'
  | 'approvalGateway'
  | 'pipelineEvidence'
  | 'graphDelivery'
  | 'mrFacts'
> {
  readonly automationWorkspaceEffects: AutomationWorkspaceEffectsFactory
  readonly repositoryBaselines: RepositoryBaselineEffectsFactory
  readonly evidenceArtifacts: EvidenceArtifactPort
  /**
   * RFC-601: the providers the daemon gives are required here; the use case keeps its own optional members and their
   * "not connected" results for an input that lacks them (RFC-396's missing graph verification binding among them).
   */
  readonly approvalGateway: NonNullable<
    DevelopmentEmployeePlatformWorkItemsInput['approvalGateway']
  >
  readonly pipelineEvidence: NonNullable<
    DevelopmentEmployeePlatformWorkItemsInput['pipelineEvidence']
  >
  readonly graphDelivery: NonNullable<DevelopmentEmployeePlatformWorkItemsInput['graphDelivery']>
  readonly mrFacts: NonNullable<DevelopmentEmployeePlatformWorkItemsInput['mrFacts']>
  readonly now?: () => number
}

export function composeDevelopmentEmployeePlatformWorkItemsFromPersistence(
  input: DevelopmentEmployeePlatformWorkItemsCompositionInput,
): ReturnType<typeof createDevelopmentEmployeePlatformWorkItems> {
  const factory = selectedAutomationWorkspaceEffects(input.automationWorkspaceEffects)
  const evidenceStore = (): EvidenceArtifactPort => input.evidenceArtifacts
  return createDevelopmentEmployeePlatformWorkItems({
    ...input,
    automationWorkspaceEffects: factory,
    baselineFileReader: (baselineRepoPath, baselineSha) =>
      createGitBaselineReader(baselineRepoPath, baselineSha, input.repositoryBaselines),
    evidenceStore,
    businessTreeDigest: async (workspacePath) =>
      businessTreeSnapshotDigest(await businessTreeSnapshot(workspacePath, factory)),
    now: input.now ?? Date.now,
  })
}

type DevelopmentEmployeePlatformWorkItemsBootstrapInput = Omit<
  DevelopmentEmployeePlatformWorkItemsCompositionInput,
  'persistence'
>

/** 一份装配，两个 provider 共用（RFC-359 W4-D13）。 */
export function composeDevelopmentEmployeePlatformWorkItems(
  input: DevelopmentEmployeePlatformWorkItemsBootstrapInput & {
    readonly db: PersistenceDb
  },
): ReturnType<typeof composeDevelopmentEmployeePlatformWorkItemsFromPersistence> {
  const { db, ...composition } = input
  return composeDevelopmentEmployeePlatformWorkItemsFromPersistence({
    ...composition,
    persistence: createEmployeePlatformWorkItemPersistence(db),
  })
}
