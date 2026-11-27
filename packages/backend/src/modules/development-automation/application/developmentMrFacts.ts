// RFC-508（RFC-294 S10 第十五步）—— 开发交付的 MR 事实：读取（失败原样返回，成功时映射快照、数未解决且不是自己的评审线程）与
// 采集（四条原文错误；成功时算快照摘要、投影事实格、给线程算摘要）。事实源端口由 integration 按结构满足、装配根注入；采集的时钟由
// 装配传入。
//
// 读取遇到「两次读之间分支动了」会重采：事实源在这种情况下整组丢弃并要求调用方重采
// （`modules/integration/application/mrFacts.ts` 文件头）。员工刚推送完修复提交就来读线程时，MR 的头提交正好从旧值变成它自己
// 推上去的新值；不重采的话，这一次读取失败会被工作项当成阻塞，交办停下来等人恢复（2026-11-27 在真实 GitLab 上遇到）。

import { canonicalDigest } from '../domain/canonicalJson'
import { projectMrCells } from '../domain/mrFacts'
import type { DevelopmentMrFactsSourcePort } from './ports/developmentDelivery'
import type { MergeRequestFactsCollectorPort } from './ports/reconcilerPorts'
import { sha256Hex } from '@/platform/contracts/hash'

export interface DevelopmentMrFactsDependencies {
  readonly mrFacts: DevelopmentMrFactsSourcePort
}

/** MR 事实读取：交给 mission 一侧的 `mrFacts`。 */
export function createDevelopmentMrFacts(deps: DevelopmentMrFactsDependencies) {
  return {
    async collect(repositoryId: string, mrRef: string, selfMarker: string) {
      // RFC-471: a missing binding is the source's `code-host-connection-missing` (same code, same text).
      let result = await deps.mrFacts.collect(repositoryId, mrRef, { selfMarker })
      // The source's two "a branch moved while I was reading" results. A branch that has just
      // moved is stable on the next read; one that keeps moving is reported after three reads.
      // Any other failure is returned at once.
      const moved = (code: string) =>
        code === 'mr-facts-head-race' || code === 'mr-facts-target-race'
      for (let read = 1; read < 3 && !result.ok && moved(result.code); read += 1)
        result = await deps.mrFacts.collect(repositoryId, mrRef, { selfMarker })
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
          // RFC-628: carried only when the list is incomplete, so a thread missing from it is not
          // taken for a deleted one; a complete read keeps exactly the shape it always had.
          ...(result.threadsIncomplete === true ? { reviewThreadsIncomplete: true as const } : {}),
        },
      }
    },
  }
}

export interface DevelopmentMrFactsCollectorDependencies {
  /** 交付 provider 的 MR 事实目标读取（与它的同名方法同形）。 */
  readonly provider: {
    readMrFactTarget(input: {
      readonly missionId: string
      readonly mrClaimId: string
    }): Promise<{ readonly repositoryId: string; readonly mrIid: string } | null>
  }
  readonly mrFacts: DevelopmentMrFactsSourcePort
  readonly now: () => number
}

/** MR 事实采集：交给 reconciler 的 `MergeRequestFactsCollectorPort`。 */
export function createDevelopmentMrFactsCollector(
  deps: DevelopmentMrFactsCollectorDependencies,
): MergeRequestFactsCollectorPort {
  const provider = deps.provider
  return {
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
      const now = deps.now()
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
  }
}
