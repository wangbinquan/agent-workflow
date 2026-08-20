// RFC-310 PR-5 —— development-automation 发布链的装配点依赖（routes 与 cli
// 共用，同 buildStartTaskDeps 先例）。
//
// 这里是唯一允许把平台横层能力（cachedRepos 凭据 URL 解封、RFC-269 code-host
// connections）翻译成 DA 结构同形端口的地方：repoRemote（repositoryId →
// remote URL + default branch）与 mrEffects（repositoryId → provider/project/
// call 绑定 → integration 的 ensure/observe）。模块内部不 import 这里。

import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { cachedRepos } from '@/db/schema'
import type {
  MergeRequestFactsCollectorPort,
  PipelineEvidencePort,
  RepoRemotePort,
} from '@/modules/development-automation/application/ports/reconcilerPorts'
import { projectMrCells } from '@/modules/development-automation/domain/mrFacts'
import { canonicalDigest } from '@/modules/development-automation/domain/canonicalJson'
import { collectMergeRequestFacts } from '@/modules/integration/application/mrFacts'
import { developmentMissions, developmentMrClaims } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { composePipelineEvidenceRunner } from '@/modules/integration/composition/pipelineEvidence'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composeDevelopmentMrEffects,
  matchRepoProvider,
  type DevelopmentMrEffects,
} from '@/modules/integration/composition/codeHostEffects'
import { resolveCodeHostConnectionsFromKeyFile } from '@/services/codeHost/connections'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { Paths } from '@/util/paths'
import { eq } from 'drizzle-orm'

export function buildDevelopmentDeliveryDeps(
  db: DbClient,
  secretBox: SecretBox | undefined,
): {
  readonly repoRemote: RepoRemotePort
  readonly mrEffects: DevelopmentMrEffects
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
            }[]
          }
        }
      | { readonly ok: false; readonly code: string; readonly detail: string }
    >
  }
} {
  const repoRemote: RepoRemotePort = {
    resolve(repositoryId) {
      const row = db
        .select({
          id: cachedRepos.id,
          urlEnc: cachedRepos.urlEnc,
          defaultBranch: cachedRepos.defaultBranch,
        })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, repositoryId))
        .get()
      if (row === undefined) return null
      const url = unsealRepoUrl(row, secretBox, db)
      if (url === null) return null
      return { remoteUrl: url, defaultBranch: row.defaultBranch }
    },
  }
  const mrEffects = composeDevelopmentMrEffects({
    binding: (repositoryId) => resolveDevelopmentRepoBinding(db, secretBox, repositoryId),
  })
  const mrFacts = {
    async collect(repositoryId: string, mrRef: string, selfMarker: string) {
      const binding = resolveDevelopmentRepoBinding(db, secretBox, repositoryId)
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
          })),
        },
      }
    },
  }
  return { repoRemote, mrEffects, mrFacts }
}

/**
 * PR-7b attach —— repositoryId → MR claim 键（provider + decoded project path，
 * 与 ensure-MR arm 从 correlationRef 拆出的键同形；attach 命令的缺省推导）。
 */
export function resolveRepoClaimKey(
  db: DbClient,
  secretBox: SecretBox | undefined,
  repositoryId: string,
): { readonly codeHostEndpointRef: string; readonly stableProjectRef: string } | null {
  const binding = resolveDevelopmentRepoBinding(db, secretBox, repositoryId)
  if (binding === null) return null
  return {
    codeHostEndpointRef: binding.provider,
    stableProjectRef: decodeURIComponent(binding.project),
  }
}

/** repositoryId → code-host connection binding（mrEffects 与 MR facts 共用）。 */
export function resolveDevelopmentRepoBinding(
  db: DbClient,
  secretBox: SecretBox | undefined,
  repositoryId: string,
): ReturnType<Parameters<typeof composeDevelopmentMrEffects>[0]['binding']> {
  const row = db
    .select({
      id: cachedRepos.id,
      urlEnc: cachedRepos.urlEnc,
      defaultBranch: cachedRepos.defaultBranch,
    })
    .from(cachedRepos)
    .where(eq(cachedRepos.id, repositoryId))
    .get()
  if (row === undefined) return null
  const url = unsealRepoUrl(row, secretBox, db)
  if (url === null) return null
  const connections = resolveCodeHostConnectionsFromKeyFile(db, Paths.secretKeyFile)
  if (connections === null) return null
  const candidates = (['gitlab', 'github'] as const)
    .map((p) => connections.resolve(p))
    .filter((c) => c !== null)
  const matched = matchRepoProvider(url, candidates)
  if (matched === null) return null
  const connection = connections.resolve(matched.provider)
  if (connection === null) return null
  return {
    provider: matched.provider,
    project: matched.project,
    call: { connection, ctx: { ports: {} } },
  }
}

/**
 * PR-7 T72 —— MR facts collector 的装配胶水：claim 行 → connection binding →
 * integration 三读 fence 采集 → DA 投影（cells）+ thread 明细（台账素材）。
 * selfMarker=missionId（与 reply 同源闭合 self 循环防护）。head race /
 * threads 截断按 loud throw 呈现——arm 不吞（collector 合同：采不到就抛）。
 */
export function buildDevelopmentMrFactsDeps(
  db: DbClient,
  secretBox: SecretBox | undefined,
): { readonly mergeRequestFacts: MergeRequestFactsCollectorPort } {
  return {
    mergeRequestFacts: {
      async collect(input) {
        if (input.mrClaimId === null) {
          throw new Error(`mission ${input.missionId} has no MR claim to collect facts for`)
        }
        const claim = db
          .select({
            mrIid: developmentMrClaims.mrIid,
            stableProjectRef: developmentMrClaims.stableProjectRef,
          })
          .from(developmentMrClaims)
          .where(eq(developmentMrClaims.id, input.mrClaimId))
          .get()
        if (claim === undefined) {
          throw new Error(`mr claim ${input.mrClaimId} not found`)
        }
        const missionRow = db
          .select({ repositoryId: developmentMissions.repositoryId })
          .from(developmentMissions)
          .where(eq(developmentMissions.id, input.missionId))
          .get()
        if (missionRow === undefined) {
          throw new Error(`mission ${input.missionId} not found`)
        }
        const binding = resolveDevelopmentRepoBinding(db, secretBox, missionRow.repositoryId)
        if (binding === null) {
          throw new Error(`no code-host binding for repository ${missionRow.repositoryId}`)
        }
        const out = await collectMergeRequestFacts(binding, claim.mrIid, {
          selfMarker: input.missionId,
        })
        if (!out.ok) {
          throw new Error(`mr facts collect failed: ${out.code}: ${out.detail}`)
        }
        const snapshot = out.snapshot
        // headSha 缺席（provider 未暴露 head）时不投影 mr cells——facts 面
        // indeterminate 让规则老实停（不伪造 head 锚定的事实）。
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

/**
 * PR-6 T63/T68 —— integration pipeline 执行面 → DA 结构同形端口的装配胶水：
 * sink 生命周期归平台（collect 的 cleanup 交给消费侧、trigger/rerun 即用即弃）、
 * AdapterFailureReceipt 压平为 code/detail。
 */
export function buildDevelopmentPipelineDeps(db: DbClient): {
  readonly pipelineEvidence: PipelineEvidencePort
} {
  const runner = composePipelineEvidenceRunner(db)
  const flat = (failure: { code: string; remediation: string }) => ({
    ok: false as const,
    code: failure.code,
    detail: failure.remediation,
  })
  return {
    pipelineEvidence: {
      async collect(input) {
        const parent = mkdtempSync(join(tmpdir(), 'aw-pipeline-sink-'))
        const out = await runner.collect({ ...input, sinkPath: parent })
        if (!out.ok) {
          rmSync(parent, { recursive: true, force: true })
          return flat(out.failure)
        }
        return {
          ok: true,
          envelope: out.envelope,
          stagedRoot: parent,
          cleanup: () => rmSync(parent, { recursive: true, force: true }),
        }
      },
      async trigger(input) {
        const parent = mkdtempSync(join(tmpdir(), 'aw-pipeline-trigger-'))
        try {
          const out = await runner.trigger({ ...input, sinkPath: parent })
          if (!out.ok) return flat(out.failure)
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
          if (!out.ok) return flat(out.failure)
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
