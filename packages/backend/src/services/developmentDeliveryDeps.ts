// RFC-310/RFC-349 — provider-neutral development delivery composition.
// Database clients, schema objects and query builders live in provider adapters.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SecretBox } from '@/auth/secretBox'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/public/operations'
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
import type { PipelineEvidenceExecution } from '@/modules/integration/infrastructure/developmentPipelineAdapter'
import { resolveCachedRepo } from '@/services/gitRepoCache'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { DomainError, NotFoundError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'

export interface DevelopmentWorkspaceRepositoryPreparation {
  prepare(input: { readonly repositoryId: string }): Promise<{
    readonly id: string
    readonly localPath: string
    readonly defaultBranch: string | null
  }>
}

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
  readonly pipeline: PipelineEvidenceExecution
}

export function assertDevelopmentWorkspaceRepositoryFreshness(input: {
  readonly repositoryId: string
  readonly urlRedacted: string
  readonly configuredDefaultBranch: string | null
  readonly preparedDefaultBranch: string | null
  readonly ffOutcomes: readonly {
    readonly branch: string
    readonly warning: string | null
  }[]
}): string {
  const defaultBranch = input.preparedDefaultBranch
  if (defaultBranch === null || defaultBranch.length === 0) {
    throw new DomainError(
      'cached-repo-default-branch-unavailable',
      `cached repo '${input.repositoryId}' has no resolvable default branch after refresh`,
      409,
      { url: input.urlRedacted },
    )
  }
  const missingConfiguredBranch = input.ffOutcomes.some(
    (outcome) =>
      outcome.branch === input.configuredDefaultBranch && outcome.warning === 'origin-ref-missing',
  )
  if (missingConfiguredBranch) {
    throw new DomainError(
      'repo-ref-not-found',
      `default branch '${input.configuredDefaultBranch}' no longer exists in ${input.urlRedacted}; refusing to freeze the stale local branch`,
      400,
      { url: input.urlRedacted, ref: input.configuredDefaultBranch },
    )
  }
  return defaultBranch
}

export function buildDevelopmentWorkspaceRepositoryPreparation(
  provider: DevelopmentWorkspaceRepositoryPreparation,
): DevelopmentWorkspaceRepositoryPreparation {
  return Object.freeze({
    prepare: (input: { readonly repositoryId: string }) => provider.prepare(input),
  })
}

/** Provider-neutral cache mechanics; bootstrap supplies the selected store. */
export function createDevelopmentWorkspaceRepositoryPreparation(input: {
  readonly store: RepositoryWorkspaceStore
  readonly appHome: string
  readonly secretBox?: SecretBox
}): DevelopmentWorkspaceRepositoryPreparation {
  return Object.freeze({
    async prepare(request: { readonly repositoryId: string }) {
      const row = await input.store.findCachedRepoById(request.repositoryId)
      if (row === null) {
        throw new NotFoundError(
          'cached-repo-not-found',
          `cached repo '${request.repositoryId}' not found`,
        )
      }
      const url = unsealRepoUrl(row, input.secretBox, input.store)
      if (url === null) {
        throw new DomainError(
          'cached-repo-credential-unavailable',
          `cached repo '${request.repositoryId}' has no readable URL (sealed with a different secret.key?)`,
          409,
        )
      }
      const prepared = await resolveCachedRepo(
        {
          store: input.store,
          appHome: input.appHome,
          secretBox: input.secretBox,
          syncBranches:
            row.defaultBranch === null || row.defaultBranch.length === 0 ? [] : [row.defaultBranch],
        },
        { url },
      )
      if (!prepared.fetchOk) {
        throw new DomainError(
          'repo-fetch-failed',
          `repository fetch failed for ${prepared.cached.urlRedacted}; refusing to freeze a stale Digital Employee baseline`,
          502,
          { url: prepared.cached.urlRedacted, stderr: prepared.fetchError },
        )
      }
      if (prepared.cached.id !== row.id) {
        throw new DomainError(
          'cached-repo-identity-mismatch',
          `cached repository identity changed while preparing '${row.id}'`,
          409,
        )
      }
      const defaultBranch = assertDevelopmentWorkspaceRepositoryFreshness({
        repositoryId: row.id,
        urlRedacted: prepared.cached.urlRedacted,
        configuredDefaultBranch: row.defaultBranch,
        preparedDefaultBranch: prepared.cached.defaultBranch,
        ffOutcomes: prepared.ffOutcomes,
      })
      return {
        id: prepared.cached.id,
        localPath: prepared.cached.localPath,
        defaultBranch,
      }
    },
  })
}

function createDevelopmentMrEffects(
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

export function buildDevelopmentDeliveryDeps(provider: DevelopmentDeliveryProvider): {
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
    pipelineEvidence: buildDevelopmentPipelineDeps(provider.pipeline).pipelineEvidence,
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

export function buildDevelopmentPipelineDeps(runner: PipelineEvidenceExecution): {
  readonly pipelineEvidence: PipelineEvidencePort
} {
  type RunnerFailure = Extract<
    Awaited<ReturnType<typeof runner.collect>>,
    { readonly ok: false }
  >['failure']
  const failed = (failure: RunnerFailure) => ({ ok: false as const, failure })
  return {
    pipelineEvidence: {
      async collect(input) {
        const parent = mkdtempSync(join(tmpdir(), 'aw-pipeline-sink-'))
        const out = await runner.collect({ ...input, sinkPath: parent })
        if (!out.ok) {
          rmSync(parent, { recursive: true, force: true })
          return failed(out.failure)
        }
        return {
          ok: true,
          envelope: out.envelope,
          stagedRoot: parent,
          outputBudget: out.outputBudget,
          cleanup: () => rmSync(parent, { recursive: true, force: true }),
        }
      },
      async trigger(input) {
        const parent = mkdtempSync(join(tmpdir(), 'aw-pipeline-trigger-'))
        try {
          const out = await runner.trigger({ ...input, sinkPath: parent })
          if (!out.ok) return failed(out.failure)
          return {
            ok: true,
            runRef: out.envelope.runRef,
            providerReceiptRef: out.envelope.providerReceiptRef,
            adopted: out.envelope.adopted,
          }
        } finally {
          rmSync(parent, { recursive: true, force: true })
        }
      },
      async rerun(input) {
        const parent = mkdtempSync(join(tmpdir(), 'aw-pipeline-rerun-'))
        try {
          const out = await runner.rerun({ ...input, sinkPath: parent })
          if (!out.ok) return failed(out.failure)
          return {
            ok: true,
            runRef: out.envelope.runRef,
            attempt: out.envelope.attempt,
            providerReceiptRef: out.envelope.providerReceiptRef,
          }
        } finally {
          rmSync(parent, { recursive: true, force: true })
        }
      },
    },
  }
}
