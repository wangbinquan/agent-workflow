// RFC-471（RFC-294 W9-D）—— 开发交付的组装：由 `services/developmentDeliveryDeps.ts` 迁来，函数体原样，只把
// 「`provider.resolveBinding` 再调 integration」换成注入的端口——MR effects（`MrEffectsPort`）与 MR 原始事实
// （`DevelopmentMrFactsSourcePort`），实现是 integration `composition/codeHostEffects.ts` 的组装，按结构满足、装配根注入。
// MR 事实的 cell 投影、快照摘要（`snapshotRef`）与线程摘要只在这里做。

import type {
  MergeRequestFactsCollectorPort,
  MrEffectsPort,
  PipelineEvidencePort,
  RepoRemotePort,
} from '../application/ports/reconcilerPorts'
import type { DevelopmentMrFactsSourcePort } from '../application/ports/developmentDelivery'
import type { PipelineStagingFactories } from '../application/ports/evidenceStaging'
import { canonicalDigest } from '../domain/canonicalJson'
import { projectMrCells } from '../domain/mrFacts'
import type { DevelopmentDeliveryProvider } from '../infrastructure/developmentDeliveryProvider'
import type { SelectedPipelineEvidenceExecution } from '../composition'
import {
  composeLegacyDevelopmentPipelineEvidence,
  composeSelectedDevelopmentPipelineEvidence,
  type LegacyPipelineEvidencePort,
} from './pipelineEvidence'
import { sha256Hex } from '@/util/hash'

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
  const mrFacts = {
    async collect(repositoryId: string, mrRef: string, selfMarker: string) {
      // RFC-471: a missing binding is the source's `code-host-connection-missing` (same code, same text).
      const result = await deps.mrFacts.collect(repositoryId, mrRef, { selfMarker })
      if (!result.ok) return result
      return {
        ok: true as const,
        snapshot: {
          state: result.snapshot.state,
          headSha: result.snapshot.headSha,
          targetSha: result.snapshot.targetSha,
          targetBranch: result.snapshot.targetBranch,
          draft: result.snapshot.draft,
          mergeableState: result.snapshot.mergeableState,
          approvalHold: result.snapshot.approvalHold,
          mergedCommitSha: result.snapshot.mergedCommitSha,
          unresolvedReviewCount: result.snapshot.threads.filter(
            (thread) => !thread.resolved && thread.authorClass !== 'self',
          ).length,
          reviewThreads: result.snapshot.threads.map((thread) => ({
            threadRef: thread.threadRef,
            revision: thread.revision,
            authorClass: thread.authorClass,
            resolved: thread.resolved,
            body: thread.lastBody,
            path: thread.path,
            messages: thread.messages,
          })),
        },
      }
    },
  }
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
  const provider = deps.provider
  return {
    mergeRequestFacts: {
      async collect(input) {
        if (input.mrClaimId === null) {
          throw new Error(`mission ${input.missionId} has no MR claim to collect facts for`)
        }
        const target = await provider.readMrFactTarget({
          missionId: input.missionId,
          mrClaimId: input.mrClaimId,
        })
        if (target === null) throw new Error(`mr claim ${input.mrClaimId} or mission not found`)
        const out = await deps.mrFacts.collect(target.repositoryId, target.mrIid, {
          selfMarker: input.missionId,
        })
        if (!out.ok) {
          // RFC-471: the binding is resolved by the source; its missing-binding code keeps the original text.
          if (out.code === 'code-host-connection-missing') {
            throw new Error(`no code-host binding for repository ${target.repositoryId}`)
          }
          throw new Error(`mr facts collect failed: ${out.code}: ${out.detail}`)
        }
        const snapshot = out.snapshot
        const snapshotRef = canonicalDigest(snapshot)
        const now = Date.now()
        return {
          cells:
            snapshot.headSha === null
              ? {}
              : projectMrCells({ ...snapshot, headSha: snapshot.headSha }, 0, snapshotRef, now),
          snapshotRef,
          headSha: snapshot.headSha,
          targetSha: snapshot.targetSha,
          threads: snapshot.threads.map((thread) => ({
            threadRef: thread.threadRef,
            revision: thread.revision,
            authorClass: thread.authorClass,
            resolved: thread.resolved,
            bodyDigest: sha256Hex(thread.lastBody),
            body: thread.lastBody,
            path: thread.path,
          })),
        }
      },
    },
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
