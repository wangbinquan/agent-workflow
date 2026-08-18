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
  PipelineEvidencePort,
  RepoRemotePort,
} from '@/modules/development-automation/application/ports/reconcilerPorts'
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
): { readonly repoRemote: RepoRemotePort; readonly mrEffects: DevelopmentMrEffects } {
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
    binding: (repositoryId) => {
      const remote = repoRemote.resolve(repositoryId)
      if (remote === null) return null
      const connections = resolveCodeHostConnectionsFromKeyFile(db, Paths.secretKeyFile)
      if (connections === null) return null
      const candidates = (['gitlab', 'github'] as const)
        .map((p) => connections.resolve(p))
        .filter((c) => c !== null)
      const matched = matchRepoProvider(remote.remoteUrl, candidates)
      if (matched === null) return null
      const connection = connections.resolve(matched.provider)
      if (connection === null) return null
      return {
        provider: matched.provider,
        project: matched.project,
        call: { connection, ctx: { ports: {} } },
      }
    },
  })
  return { repoRemote, mrEffects }
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
