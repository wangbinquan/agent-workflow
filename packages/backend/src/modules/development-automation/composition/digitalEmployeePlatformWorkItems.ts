// RFC-495 (RFC-294 S10 step 2): the platform work-item use cases live in
// application/employeePlatformWorkItems.ts. This file only assembles them: it selects the workspace effects,
// creates the evidence store on first use, binds the business-tree digest and the baseline file reader to
// their local implementations, and supplies the default clock.
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
import {
  businessTreeSnapshot,
  businessTreeSnapshotDigest,
} from '../infrastructure/workspaceValidator'
import { EvidenceStore } from '../infrastructure/evidenceStore'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export interface DevelopmentEmployeePlatformWorkItemsCompositionInput extends Omit<
  DevelopmentEmployeePlatformWorkItemsInput,
  | 'automationWorkspaceEffects'
  | 'baselineFileReader'
  | 'evidenceStore'
  | 'businessTreeDigest'
  | 'now'
> {
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  readonly repositoryBaselines?: RepositoryBaselineEffectsFactory
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly now?: () => number
}

export function composeDevelopmentEmployeePlatformWorkItemsFromPersistence(
  input: DevelopmentEmployeePlatformWorkItemsCompositionInput,
): ReturnType<typeof createDevelopmentEmployeePlatformWorkItems> {
  const factory = selectedAutomationWorkspaceEffects(input.automationWorkspaceEffects)
  let pipelineEvidenceStore: EvidenceStore | undefined
  const evidenceStore = (): EvidenceArtifactPort =>
    input.evidenceArtifacts ??
    (pipelineEvidenceStore ??= new EvidenceStore(
      factory.resolve(factory.applicationRootReference ?? input.appHome, 'evidence'),
    ))
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
