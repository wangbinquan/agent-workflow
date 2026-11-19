// RFC-471（RFC-294 W9-D）—— 开发交付的组装：由 `services/developmentDeliveryDeps.ts` 迁来，函数体原样，只把
// 「`provider.resolveBinding` 再调 integration」换成注入的端口——MR effects（`MrEffectsPort`）与 MR 原始事实
// （`DevelopmentMrFactsSourcePort`），实现是 integration `composition/codeHostEffects.ts` 的组装，按结构满足、装配根注入。
// MR 事实的读取与采集（cell 投影、快照摘要 `snapshotRef` 与线程摘要）在 application 的 `developmentMrFacts.ts`（RFC-508）。

import type {
  MergeRequestFactsCollectorPort,
  MrEffectsPort,
  PipelineEvidencePort,
  RepoRemotePort,
} from '../application/ports/reconcilerPorts'
import type { DevelopmentMrFactsSourcePort } from '../application/ports/developmentDelivery'
import type { PipelineStagingFactories } from '../application/ports/evidenceStaging'
import {
  createDevelopmentMrFacts,
  createDevelopmentMrFactsCollector,
} from '../application/developmentMrFacts'
import type { DevelopmentDeliveryProvider } from '../infrastructure/developmentDeliveryProvider'
import type { SelectedPipelineEvidenceExecution } from '../composition'
import {
  composeLegacyDevelopmentPipelineEvidence,
  composeSelectedDevelopmentPipelineEvidence,
  type LegacyPipelineEvidencePort,
} from './pipelineEvidence'

type PipelineEvidenceExecution = Parameters<typeof composeLegacyDevelopmentPipelineEvidence>[0]

export function composeDevelopmentDeliveryDeps(deps: {
  readonly provider: DevelopmentDeliveryProvider
  readonly mrEffects: MrEffectsPort
  readonly mrFacts: DevelopmentMrFactsSourcePort
  readonly staging: PipelineStagingFactories
}): {
  readonly repoRemote: RepoRemotePort
  readonly mrEffects: MrEffectsPort
  readonly pipelineEvidence: PipelineEvidencePort
  readonly mrFacts: {
    collect(
      repositoryId: string,
      mrRef: string,
      selfMarker: string,
    ): Promise<
      | {
          readonly ok: true
          readonly snapshot: {
            readonly state: 'opened' | 'merged' | 'closed'
            readonly headSha: string | null
            readonly targetSha: string | null
            readonly targetBranch: string | null
            readonly draft: boolean
            readonly mergeableState: 'mergeable' | 'conflict' | 'unknown'
            readonly approvalHold: boolean | null
            readonly mergedCommitSha: string | null
            readonly unresolvedReviewCount: number
            readonly reviewThreads: readonly {
              readonly threadRef: string
              readonly revision: string
              readonly authorClass: 'human' | 'bot' | 'self'
              readonly resolved: boolean
              readonly body: string
              readonly path: string | null
              readonly messages: readonly {
                readonly messageRef: string
                readonly parentMessageRef: string | null
                readonly authorClass: 'human' | 'bot' | 'self'
                readonly body: string
                readonly path: string | null
                readonly createdAt: string | null
              }[]
            }[]
          }
        }
      | { readonly ok: false; readonly code: string; readonly detail: string }
    >
  }
} {
  const provider = deps.provider
  const repoRemote: RepoRemotePort = {
    resolve: (repositoryId) => provider.resolveRepository(repositoryId),
  }
  const mrFacts = createDevelopmentMrFacts({ mrFacts: deps.mrFacts })
  return {
    repoRemote,
    mrEffects: deps.mrEffects,
    mrFacts,
    pipelineEvidence: composeDevelopmentPipelineDeps(provider.pipeline, deps.staging)
      .pipelineEvidence,
  }
}

export function composeDevelopmentMrFactsCollector(deps: {
  readonly provider: Pick<DevelopmentDeliveryProvider, 'readMrFactTarget'>
  readonly mrFacts: DevelopmentMrFactsSourcePort
}): { readonly mergeRequestFacts: MergeRequestFactsCollectorPort } {
  return {
    mergeRequestFacts: createDevelopmentMrFactsCollector({
      provider: deps.provider,
      mrFacts: deps.mrFacts,
      now: () => Date.now(),
    }),
  }
}

/** Explicit legacy bridge; actual roots pass a complete neutral staging selection. */
export function composeDevelopmentPipelineDeps(runner: PipelineEvidenceExecution): {
  readonly pipelineEvidence: LegacyPipelineEvidencePort
}
export function composeDevelopmentPipelineDeps(
  runner: SelectedPipelineEvidenceExecution,
  staging: PipelineStagingFactories,
): {
  readonly pipelineEvidence: PipelineEvidencePort
}
export function composeDevelopmentPipelineDeps(
  runner: PipelineEvidenceExecution | SelectedPipelineEvidenceExecution,
  staging?: PipelineStagingFactories,
): { readonly pipelineEvidence: LegacyPipelineEvidencePort | PipelineEvidencePort } {
  return staging === undefined
    ? composeLegacyDevelopmentPipelineEvidence(runner as PipelineEvidenceExecution)
    : composeSelectedDevelopmentPipelineEvidence(
        runner as SelectedPipelineEvidenceExecution,
        staging,
      )
}
