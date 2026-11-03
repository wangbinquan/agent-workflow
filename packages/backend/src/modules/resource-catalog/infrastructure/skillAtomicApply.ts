// RFC-401 T5（design §10.2）—— skill 写入场景：普通 CRUD 与 fusion 的技能写入经 AtomicApply。
//
// 一次写入 = 一条 `skill_apply_journal` + 一条持久 claim（scene = `skill`）+ 技能锁（`skill_operation_locks`，op_id = journal id）。
// 锁在 claim 事务里取（被占 → 409 `skill-operation-busy`），在终态结算时释放；数据库行只经唯一的 skill 写入参与者
// （`skillMutationParticipant.ts`）。顺序：
//   prepare：先记工件再动内容（暂存版本树并固化版本快照 / 把整棵根移入 trash）；普通编辑内容与 live 相同则丢弃暂存（不变写入）；
//   commit ：参与者写行（复合前置条件、版本号、metaRevision、引用复查），与 journal committed 同一事务；
//   尾部   ：发布 live、清理候选或 trash；未完成留给恢复前滚（AtomicApply 恢复在维护作业与启动时收敛，不再等到重启）。
// 提交前失败按工件补偿并记为 failed；补偿未完成留给恢复。

import { ulid } from 'ulid'

import { createAtomicApplyClaimStore } from '@/platform/atomic-apply/infrastructure/claimStore'
import { createAtomicApply } from '@/platform/atomic-apply/stateMachine'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { NotFoundError, staleConflictError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type {
  SkillContentKind,
  SkillVersionMutation,
  SkillVersionMutationHooks,
  SkillVersionMutationResult,
} from '../application/ports/skillMutation'
import type {
  SkillCreationContentStore,
  SkillInitialContent,
} from '../application/skills/creationContentStore'
import type { SkillDeletionContentStore } from '../application/skills/deletionContentStore'
import type { SkillTreeContentStore } from '../application/skills/treeContentStore'
import type {
  SkillVersionContentChange,
  SkillVersionContentStore,
  SkillVersionPublication,
} from '../application/skills/versionContentStore'
import type { SkillVersionCompositeExpectation } from '../domain/skillVersionCommit'
import {
  skillVersionCompositeDrifted,
  skillVersionCompositeFenceRequested,
} from '../domain/skillVersionCommit'
import { markSkillBootVerified, unmarkSkillBootVerified } from './legacy/skillBootVerify'
import { acquireOpLocks, releaseOpLocks } from './legacy/skillOperations'
import {
  createSkillApplyJournal,
  SKILL_APPLY_SCENE,
  skillApplyArtifactCodecs,
  skillApplyErrors,
  skillApplyReceiptCodec,
  type SkillApplyArtifact,
  type SkillApplyReceipt,
} from './skillApplyJournal'
import { createSkillMutationParticipant } from './skillMutationParticipant'
import { readSkillVersionCompositeLive } from './skillVersionCommitParticipant'

/** 一个部署选定的技能内容存储（本地文件或数据库字节）；写入与恢复用同一份选择。 */
export interface SkillApplyContent {
  readonly contentKind: SkillContentKind
  readonly versionContent: SkillVersionContentStore
  readonly creationContent: SkillCreationContentStore
  readonly deletionContent: SkillDeletionContentStore
  /** fusion 候选树的清理；没有 fusion 的装配可以不给。 */
  readonly treeContent?: SkillTreeContentStore
}

export interface SkillApplySceneDependencies {
  readonly db: PersistenceDb
  readonly content: SkillApplyContent
  readonly now?: () => number
  readonly id?: () => string
  readonly log?: Logger
}

/** 测试用故障注入点：提交之后、发布之前；补偿之前。 */
export interface SkillApplyFaults {
  readonly afterCommit?: () => void
  readonly beforeCompensate?: () => void
}

export interface SkillVersionWriteRequest {
  readonly skillId: string
  readonly faults?: SkillApplyFaults
  readonly change: SkillVersionContentChange
  /** 普通编辑：暂存内容与 live 相同 → 不写版本（只复核前置条件）。restore 与 fusion 不比较。 */
  readonly compareLive?: boolean
  readonly mutation: Omit<
    SkillVersionMutation,
    'skillId' | 'versionIndex' | 'contentHash' | 'contentKind' | 'now' | 'hooks'
  >
  /** 提交事务内的场景读写（fusion 重验并结算自身、restore 退回记忆），拿到的是提交事务。 */
  readonly hooks?: (tx: PersistenceTx) => SkillVersionMutationHooks
  /** fusion：提交后的尾部清理这个候选树。 */
  readonly candidateId?: string
}

export interface SkillCreateWriteRequest {
  readonly id?: string
  readonly faults?: SkillApplyFaults
  readonly name: string
  readonly description: string
  readonly ownerUserId: string | null
  readonly authorUserId: string | null
  readonly initial: SkillInitialContent
}

export interface SkillDeleteWriteRequest {
  readonly skillId: string
  readonly faults?: SkillApplyFaults
  readonly fence?: SkillVersionCompositeExpectation
  /** 测试用阶段回调：claim 之后、移入 trash 之后、提交之后。 */
  readonly afterPhase?: (
    phase: 'intent' | 'fs-staged' | 'db-committed',
    skillId: string,
  ) => Promise<void> | void
}

interface PreparedVersion {
  readonly publication: SkillVersionPublication | null
  readonly contentHash: string
  readonly versionIndex: number
}

function initialChange(initial: SkillInitialContent): SkillVersionContentChange {
  return initial.kind === 'main'
    ? { kind: 'replace-files', files: [], mainContent: initial.content }
    : { kind: 'replace-files', files: initial.files, mainContent: initial.mainContent }
}

function versionArtifact(
  contentKind: SkillContentKind,
  plan: ReturnType<SkillVersionContentStore['plan']>,
  create: boolean,
): SkillApplyArtifact {
  return {
    kind: 'skill-version',
    contentKind,
    skillId: plan.skillId,
    version: plan.version,
    publicationId: plan.publicationId,
    liveRef: plan.liveRef,
    stagingRef: plan.stagingRef,
    versionRef: plan.versionRef,
    stagingJournalRef: plan.stagingJournalRef,
    versionJournalRef: plan.versionJournalRef,
    create,
  }
}

export function publicationOfSkillArtifact(
  artifact: Extract<SkillApplyArtifact, { kind: 'skill-version' }>,
): SkillVersionPublication {
  return {
    skillId: artifact.skillId,
    version: artifact.version,
    publicationId: artifact.publicationId,
    liveRef: artifact.liveRef,
    stagingRef: artifact.stagingRef,
    versionRef: artifact.versionRef,
  }
}

function staleSkill(skillId: string, message?: string): Error {
  return staleConflictError(
    'skill',
    message ?? `skill '${skillId}' changed since this operation started; reload and retry`,
  )
}

/** 提交前按工件逆序补偿；返回未完成的错误（交给 AtomicApply 记为可重试）。 */
export async function compensateSkillArtifacts(
  content: Pick<SkillApplyContent, 'versionContent' | 'creationContent' | 'deletionContent'>,
  artifacts: readonly SkillApplyArtifact[],
  recovery: boolean,
): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const artifact of [...artifacts].reverse()) {
    try {
      if (artifact.kind === 'skill-version') {
        await content.versionContent.abort(publicationOfSkillArtifact(artifact))
        if (artifact.create)
          await content.creationContent.discard(content.creationContent.plan(artifact.skillId))
      } else if (artifact.kind === 'skill-delete') {
        await content.deletionContent.rollback(
          content.deletionContent.plan({
            skillId: artifact.skillId,
            operationId: artifact.operationId,
            recordedBackupRef: artifact.backupJournalRef,
          }),
          recovery,
        )
      }
      // skill-candidate：候选树归 fusion 所有，提交前失败不动它。
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

export function createSkillApplyScene(dependencies: SkillApplySceneDependencies) {
  const now = dependencies.now ?? Date.now
  const log = dependencies.log ?? createLogger('skillApply')
  const { db, content } = dependencies
  const machine = createAtomicApply({
    journal: createSkillApplyJournal(db),
    claims: createAtomicApplyClaimStore(SKILL_APPLY_SCENE),
    token: ulid,
    codecs: {
      encode: (artifacts: readonly SkillApplyArtifact[]) =>
        skillApplyArtifactCodecs.encode(artifacts),
    },
    receipt: skillApplyReceiptCodec,
    errors: skillApplyErrors,
    id: dependencies.id ?? ulid,
    now,
  })
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

  async function claim(
    skillId: string,
    operation: 'create' | 'version' | 'delete',
    withinClaim?: (tx: PersistenceTx) => Promise<void>,
  ): Promise<string> {
    const claimed = await machine.claim({
      key: { id: ulid() },
      beforeLookup: async () => undefined,
      prepare: async () => ({ insert: { skillId, operation }, value: undefined }),
      withinClaim: async (tx, journalId) => {
        await withinClaim?.(tx)
        await acquireOpLocks(tx, journalId, [skillId])
      },
    })
    // 幂等键每次新铸，不会命中重放。
    if (claimed.kind !== 'claimed') throw new Error('skill-apply-unexpected-replay')
    return claimed.journalId
  }

  const settle = (journalId: string) => async (tx: PersistenceTx) => {
    await releaseOpLocks(tx, journalId)
  }

  async function currentSkill(skillId: string) {
    const { skills } = tablesOf(db)
    const row = await first(
      db
        .select({
          contentVersion: skills.contentVersion,
          metaRevision: skills.metaRevision,
          name: skills.name,
        })
        .from(skills)
        .where(eq(skills.id, skillId))
        .limit(1),
    )
    if (row === undefined)
      throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
    return row
  }

  async function version(request: SkillVersionWriteRequest): Promise<SkillVersionMutationResult> {
    const current = await currentSkill(request.skillId)
    const { fence } = request.mutation
    // 暂存之前的快速判定；带 hooks 的调用方（fusion）先答自己的检查，栅栏只在提交事务里判，错误优先级不变。
    if (
      request.hooks === undefined &&
      fence.expectedVersion !== undefined &&
      fence.expectedVersion !== current.contentVersion
    )
      throw staleSkill(
        request.skillId,
        fence.staleMessage ??
          `skill '${current.name}' is at version ${current.contentVersion}, expected ${fence.expectedVersion}; reload and retry`,
      )
    const journalId = await claim(request.skillId, 'version')
    const receipt = await machine.execute({
      journalId,
      async prepare(recordArtifact): Promise<PreparedVersion> {
        // 锁已持有：此刻读到的版本号就是这次写入的基线，claim 之前别人提交的版本不会被当成 stale。
        const versionIndex = (await currentSkill(request.skillId)).contentVersion + 1
        const plan = content.versionContent.plan({
          skillId: request.skillId,
          version: versionIndex,
          publicationId: ulid(),
        })
        await recordArtifact(versionArtifact(content.contentKind, plan, false))
        const staged = await content.versionContent.stage(
          plan,
          request.change,
          request.compareLive === true,
        )
        if (request.compareLive === true && staged.matchesLive) {
          // 内容不变：丢弃暂存（版本快照还没固化），提交只复核前置条件。
          await content.versionContent.discardStage(plan)
          return { publication: null, contentHash: staged.contentHash, versionIndex }
        }
        await content.versionContent.captureVersion(plan)
        if (request.candidateId !== undefined)
          await recordArtifact({
            kind: 'skill-candidate',
            contentKind: content.contentKind,
            skillId: request.skillId,
            candidateId: request.candidateId,
          })
        return { publication: plan, contentHash: staged.contentHash, versionIndex }
      },
      async commit(tx, _journalId, prepared) {
        let result: SkillVersionMutationResult
        const hooks = request.hooks?.(tx)
        if (prepared.publication === null) {
          await hooks?.before?.()
          const live = await readSkillVersionCompositeLive(tx, request.skillId)
          if (
            live === null ||
            (skillVersionCompositeFenceRequested(fence) &&
              skillVersionCompositeDrifted(live, fence))
          )
            throw staleSkill(request.skillId, fence.staleMessage)
          result = {
            outcome: 'already-current',
            versionIndex: live.contentVersion,
            metaRevision: live.metaRevision,
          }
        } else {
          result = await createSkillMutationParticipant(tx).version({
            ...request.mutation,
            skillId: request.skillId,
            versionIndex: prepared.versionIndex,
            contentKind: content.contentKind,
            contentHash: prepared.contentHash,
            now: now(),
            ...(hooks === undefined ? {} : { hooks }),
          })
        }
        const value: SkillApplyReceipt = {
          skillId: request.skillId,
          operation: 'version',
          outcome: result.outcome,
          contentVersion: result.versionIndex,
          metaRevision: result.metaRevision,
        }
        return { receipt: value, prepared }
      },
      async afterCommit({ receipt, prepared }) {
        if (prepared.publication === null) return true
        if (receipt.outcome === 'already-current') {
          // 参与者判定内容与当前版本相同：这一版没有写入，暂存按未发布丢弃。
          await content.versionContent.abort(prepared.publication)
        } else {
          // 数据库已指向 live 尚未发布的一代：先撤掉上一代的可用判定，发布并校验后再标记。
          unmarkSkillBootVerified(request.skillId)
          request.faults?.afterCommit?.()
          await content.versionContent.publish(prepared.publication, prepared.contentHash)
          markSkillBootVerified(request.skillId)
        }
        if (request.candidateId !== undefined && content.treeContent !== undefined)
          await content.treeContent.discardCandidate({
            skillId: request.skillId,
            candidateId: request.candidateId,
          })
        return true
      },
      compensate: (artifacts) => {
        request.faults?.beforeCompensate?.()
        return compensateSkillArtifacts(content, artifacts, false)
      },
      async committedFailure(error) {
        log.warn('skill-apply-publication-retryable', { journalId, err: errorText(error) })
      },
      leftRetryable(error, errors) {
        log.warn('skill-apply-left-retryable', {
          journalId,
          err: errorText(error),
          cleanup: errors.map(errorText).join('; '),
        })
      },
      settle: settle(journalId),
    })
    return receipt.outcome === 'committed'
      ? {
          outcome: 'committed',
          versionIndex: receipt.contentVersion,
          metaRevision: receipt.metaRevision,
          versionRowId: '',
        }
      : {
          outcome: 'already-current',
          versionIndex: receipt.contentVersion,
          metaRevision: receipt.metaRevision,
        }
  }

  async function create(request: SkillCreateWriteRequest): Promise<string> {
    const skillId = request.id ?? ulid()
    const journalId = await claim(skillId, 'create')
    await machine.execute({
      journalId,
      async prepare(recordArtifact) {
        const plan = content.versionContent.plan({ skillId, version: 1, publicationId: ulid() })
        await recordArtifact(versionArtifact(content.contentKind, plan, true))
        const staged = await content.versionContent.stage(
          plan,
          initialChange(request.initial),
          false,
        )
        await content.versionContent.captureVersion(plan)
        return { publication: plan, contentHash: staged.contentHash }
      },
      async commit(tx, _journalId, prepared) {
        await createSkillMutationParticipant(tx).create({
          id: skillId,
          name: request.name,
          description: request.description,
          ownerUserId: request.ownerUserId,
          contentKind: content.contentKind,
          contentHash: prepared.contentHash,
          authorUserId: request.authorUserId,
          now: now(),
        })
        const value: SkillApplyReceipt = {
          skillId,
          operation: 'create',
          outcome: 'committed',
          contentVersion: 1,
          metaRevision: 0,
        }
        return { receipt: value, prepared }
      },
      async afterCommit({ prepared }) {
        request.faults?.afterCommit?.()
        await content.versionContent.publish(prepared.publication, prepared.contentHash)
        markSkillBootVerified(skillId)
        return true
      },
      compensate: (artifacts) => {
        request.faults?.beforeCompensate?.()
        return compensateSkillArtifacts(content, artifacts, false)
      },
      async committedFailure(error) {
        log.warn('skill-apply-publication-retryable', { journalId, err: errorText(error) })
      },
      leftRetryable(error, errors) {
        log.warn('skill-apply-left-retryable', {
          journalId,
          err: errorText(error),
          cleanup: errors.map(errorText).join('; '),
        })
      },
      settle: settle(journalId),
    })
    return skillId
  }

  async function remove(request: SkillDeleteWriteRequest): Promise<void> {
    const assertFence = async (tx: PersistenceTx) => {
      if (request.fence === undefined || !skillVersionCompositeFenceRequested(request.fence)) return
      if (
        skillVersionCompositeDrifted(
          await readSkillVersionCompositeLive(tx, request.skillId),
          request.fence,
        )
      )
        throw staleSkill(request.skillId, request.fence.staleMessage)
    }
    const journalId = await claim(request.skillId, 'delete', assertFence)
    await machine.execute({
      journalId,
      async prepare(recordArtifact) {
        const plan = content.deletionContent.plan({
          skillId: request.skillId,
          operationId: journalId,
        })
        await recordArtifact({
          kind: 'skill-delete',
          contentKind: content.contentKind,
          skillId: request.skillId,
          operationId: journalId,
          backupJournalRef: plan.backupJournalRef,
        })
        await request.afterPhase?.('intent', request.skillId)
        await content.deletionContent.stage(plan)
        await request.afterPhase?.('fs-staged', request.skillId)
        return plan
      },
      async commit(tx, _journalId, plan) {
        await createSkillMutationParticipant(tx).delete({
          skillId: request.skillId,
          ...(request.fence === undefined ? {} : { fence: request.fence }),
        })
        const value: SkillApplyReceipt = {
          skillId: request.skillId,
          operation: 'delete',
          outcome: 'committed',
          contentVersion: 0,
          metaRevision: 0,
        }
        return { receipt: value, plan }
      },
      async afterCommit({ plan }) {
        unmarkSkillBootVerified(request.skillId)
        await request.afterPhase?.('db-committed', request.skillId)
        request.faults?.afterCommit?.()
        await content.deletionContent.discard(plan)
        return true
      },
      compensate: (artifacts) => {
        request.faults?.beforeCompensate?.()
        return compensateSkillArtifacts(content, artifacts, false)
      },
      async committedFailure(error) {
        log.warn('skill-apply-delete-retryable', { journalId, err: errorText(error) })
      },
      leftRetryable(error, errors) {
        log.warn('skill-apply-left-retryable', {
          journalId,
          err: errorText(error),
          cleanup: errors.map(errorText).join('; '),
        })
      },
      settle: settle(journalId),
    })
  }

  return Object.freeze({
    version,
    create,
    delete: remove,
    activeJournalIds: machine.activeJournalIds,
  })
}

export type SkillApplyScene = ReturnType<typeof createSkillApplyScene>
