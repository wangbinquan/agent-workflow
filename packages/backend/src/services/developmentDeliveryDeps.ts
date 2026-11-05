// RFC-310/RFC-349 — provider-neutral development delivery composition.
// Database clients, schema objects and query builders live in provider adapters.

import type {
  MergeRequestFactsCollectorPort,
  PipelineEvidencePort,
  RepoRemotePort,
} from '@/modules/development-automation/application/ports/reconcilerPorts'
import { canonicalDigest } from '@/modules/development-automation/domain/canonicalJson'
import { projectMrCells } from '@/modules/development-automation/domain/mrFacts'
import {
  collectMergeRequestFacts,
  replyMergeRequestThread,
} from '@/modules/integration/application/mrFacts'
import {
  ensureMergeRequest,
  observeMergeRequest,
  type MrEnsureConnectionDeps,
} from '@/modules/integration/application/mrEnsure'
import type { DevelopmentMrEffects } from '@/modules/integration/composition/codeHostEffects'
import type {
  PipelineEvidenceExecution,
  SelectedPipelineEvidenceExecution,
} from '@/modules/integration/public/participants'
import type { PipelineStagingFactories } from '@/modules/development-automation/public/types'
import {
  composeSelectedDevelopmentPipelineEvidence,
  composeLegacyDevelopmentPipelineEvidence,
  type LegacyPipelineEvidencePort,
} from '@/modules/development-automation/public/participants'
import { sha256Hex } from '@/util/hash'

export interface DevelopmentDeliveryProvider {
  resolveRepository(repositoryId: string): Promise<{
    readonly remoteUrl: string
    readonly defaultBranch: string | null
  } | null>
  resolveBinding(repositoryId: string): Promise<MrEnsureConnectionDeps | null>
  readMrFactTarget(input: {
    readonly missionId: string
    readonly mrClaimId: string
  }): Promise<{ readonly repositoryId: string; readonly mrIid: string } | null>
  readonly pipeline: SelectedPipelineEvidenceExecution
}

export function createDevelopmentMrEffects(
  provider: Pick<DevelopmentDeliveryProvider, 'resolveBinding'>,
): DevelopmentMrEffects {
  const missing = (repositoryId: string) => ({
    ok: false as const,
    code: 'code-host-connection-missing',
    detail: `no code-host binding for repository ${repositoryId}`,
  })
  return {
    async ensure(repositoryId, input) {
      const binding = await provider.resolveBinding(repositoryId)
      if (binding === null) return missing(repositoryId)
      const out = await ensureMergeRequest(binding, input)
      return out.ok ? { ok: true, mr: out.mr } : out
    },
    async reply(repositoryId, input) {
      const binding = await provider.resolveBinding(repositoryId)
      if (binding === null) return missing(repositoryId)
      const out = await replyMergeRequestThread(binding, input)
      return out.ok ? { ok: true, noteRef: out.noteRef } : out
    },
    async observe(repositoryId, mrRef) {
      const binding = await provider.resolveBinding(repositoryId)
      if (binding === null) return missing(repositoryId)
      const out = await observeMergeRequest(binding, mrRef)
      return out.ok ? { ok: true, observation: out.mr } : out
    },
  }
}

export function buildDevelopmentDeliveryDeps(
  provider: DevelopmentDeliveryProvider,
  staging: PipelineStagingFactories,
): {
  readonly repoRemote: RepoRemotePort
  readonly mrEffects: DevelopmentMrEffects
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
  const repoRemote: RepoRemotePort = {
    resolve: (repositoryId) => provider.resolveRepository(repositoryId),
  }
  const mrFacts = {
    async collect(repositoryId: string, mrRef: string, selfMarker: string) {
      const binding = await provider.resolveBinding(repositoryId)
      if (binding === null) {
        return {
          ok: false as const,
          code: 'code-host-connection-missing',
          detail: `no code-host binding for repository ${repositoryId}`,
        }
      }
      const result = await collectMergeRequestFacts(binding, mrRef, { selfMarker })
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
    mrEffects: createDevelopmentMrEffects(provider),
    mrFacts,
    pipelineEvidence: buildDevelopmentPipelineDeps(provider.pipeline, staging).pipelineEvidence,
  }
}

export async function resolveRepoClaimKey(
  provider: Pick<DevelopmentDeliveryProvider, 'resolveBinding'>,
  repositoryId: string,
): Promise<{ readonly codeHostEndpointRef: string; readonly stableProjectRef: string } | null> {
  const binding = await provider.resolveBinding(repositoryId)
  if (binding === null) return null
  return {
    codeHostEndpointRef: binding.provider,
    stableProjectRef: decodeURIComponent(binding.project),
  }
}

export async function resolveDevelopmentRepoBinding(
  provider: Pick<DevelopmentDeliveryProvider, 'resolveBinding'>,
  repositoryId: string,
): Promise<MrEnsureConnectionDeps | null> {
  return await provider.resolveBinding(repositoryId)
}

export function buildDevelopmentMrFactsDeps(
  provider: Pick<DevelopmentDeliveryProvider, 'readMrFactTarget' | 'resolveBinding'>,
): { readonly mergeRequestFacts: MergeRequestFactsCollectorPort } {
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
        const binding = await provider.resolveBinding(target.repositoryId)
        if (binding === null) {
          throw new Error(`no code-host binding for repository ${target.repositoryId}`)
        }
        const out = await collectMergeRequestFacts(binding, target.mrIid, {
          selfMarker: input.missionId,
        })
        if (!out.ok) throw new Error(`mr facts collect failed: ${out.code}: ${out.detail}`)
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
export function buildDevelopmentPipelineDeps(runner: PipelineEvidenceExecution): {
  readonly pipelineEvidence: LegacyPipelineEvidencePort
}
export function buildDevelopmentPipelineDeps(
  runner: SelectedPipelineEvidenceExecution,
  staging: PipelineStagingFactories,
): {
  readonly pipelineEvidence: PipelineEvidencePort
}
export function buildDevelopmentPipelineDeps(
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
