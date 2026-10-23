// RFC-370 §10 V20 —— 融合（以及任何「整树替换成下一版」的写入）经 resource-catalog 推进技能版本。
//
// 一份实现，两种内容绑定：暂存 / 发布 / 回退全走 legacy 版本漏斗（`stageSkillVersion` 开带锁的
// version-write 操作并经选定的内容仓暂存，`publishStagedSkillVersion` 发布并收尾），所以本地文件与
// 数据库存储的崩溃恢复都是既有那一份（`versionWriteRecoveryHandler`）。提交段是 tx-bound：
// 调用方开事务，`before` 先跑（融合重验自身），然后复合栅栏、版本行、`after`、操作日志推进到
// db-committed——与版本行同一事务，恢复据此判前滚还是回滚。
//
// 种子与候选树经 `SkillTreeContentStore`：严格读某一版本的不可变快照（缺失即 null，没有 live 兜底），
// 候选树与技能同生同灭。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { NotFoundError, ValidationError, staleConflictError } from '@/util/errors'

import { createSkillVersionCommitParticipantInTx } from '../application/skillVersionCommit'
import type { SkillPackageContentEntry } from '../application/skills/packageContentReader'
import type { SkillTreeContentStore } from '../application/skills/treeContentStore'
import {
  planSkillVersionCommit,
  skillVersionCompositeDrifted,
  skillVersionCompositeFenceRequested,
} from '../domain/skillVersionCommit'
import type {
  SkillTreeVersionFile,
  SkillTreeVersionOperations,
  SkillTreeVersionStageRequest,
  SkillVersionCommitHooks,
  SkillVersionCommitParticipantInTx,
  StagedSkillTreeVersion,
} from '../public/participants'
import { unmarkSkillBootVerified } from './legacy/skillBootVerify'
import { skillVersionRelPath } from './legacy/skillIdentityPaths'
import { advancePhase } from './legacy/skillOperations'
import {
  abortStagedSkillVersion,
  publishStagedSkillVersion,
  skillMainDescription,
  stageSkillVersion,
  type SkillVersionFsOptions,
  type StagedSkillVersion,
} from './legacy/skillVersion'
import { readSkillVersionCompositeLive } from './skillVersionCommitParticipant'

const MAIN = 'SKILL.md'

export interface SkillTreeVersionParticipant extends SkillTreeVersionOperations {
  inTransaction(transaction: PersistenceTx): SkillVersionCommitParticipantInTx
}

interface StagedEntry {
  readonly staged: StagedSkillVersion
  readonly request: SkillTreeVersionStageRequest
  /** What the staged SKILL.md declares; committed with the version. */
  readonly description: string
}

const toFiles = (
  entries: readonly SkillPackageContentEntry[] | null,
): readonly SkillTreeVersionFile[] | null =>
  entries === null
    ? null
    : entries.map((entry) => Object.freeze({ path: entry.path, content: entry.bytes }))

/** SKILL.md travels as the main content (`replace-files`); it must be UTF-8 text. */
function mainContentOf(files: readonly SkillTreeVersionFile[]): string {
  const main = files.find((file) => file.path === MAIN)
  if (main === undefined)
    throw new ValidationError('skill-tree-main-missing', 'the skill tree has no SKILL.md')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(main.content)
  } catch {
    throw new ValidationError('skill-tree-main-invalid', 'SKILL.md is not UTF-8 text')
  }
}

export function createSkillTreeVersionParticipant(input: {
  readonly db: PersistenceDb
  readonly fs: SkillVersionFsOptions
  readonly trees: SkillTreeContentStore
}): SkillTreeVersionParticipant {
  const stagedVersions = new WeakMap<StagedSkillTreeVersion, StagedEntry>()
  const entryOf = (handle: StagedSkillTreeVersion): StagedEntry => {
    const entry = stagedVersions.get(handle)
    if (entry === undefined)
      throw new Error('skill tree version was not staged by this participant')
    return entry
  }

  async function sourceFiles(
    request: SkillTreeVersionStageRequest,
  ): Promise<readonly SkillTreeVersionFile[]> {
    if (request.source.kind === 'tree') return request.source.files
    const candidate = toFiles(
      await input.trees.readCandidate({
        skillId: request.skillId,
        candidateId: request.source.candidateId,
      }),
    )
    if (candidate === null)
      throw new NotFoundError(
        'skill-candidate-not-found',
        `skill candidate '${request.source.candidateId}' not found`,
      )
    return candidate
  }

  return Object.freeze({
    async readVersionTree(request: { readonly skillId: string; readonly version: number }) {
      return toFiles(await input.trees.readVersion(request))
    },
    async captureCandidate(request: {
      readonly skillId: string
      readonly candidateId: string
      readonly files: readonly SkillTreeVersionFile[]
    }) {
      await input.trees.writeCandidate({
        skillId: request.skillId,
        candidateId: request.candidateId,
        files: request.files.map((file) => ({ path: file.path, bytes: file.content })),
      })
    },
    async readCandidate(request: { readonly skillId: string; readonly candidateId: string }) {
      return toFiles(await input.trees.readCandidate(request))
    },
    async discardCandidate(request: { readonly skillId: string; readonly candidateId: string }) {
      await input.trees.discardCandidate(request)
    },
    async stage(request: SkillTreeVersionStageRequest) {
      const files = await sourceFiles(request)
      const mainContent = mainContentOf(files)
      // The composite fence is judged inside the committing transaction, after
      // the caller's own `before` checks (see SkillVersionCommitHooks).
      const staged = await stageSkillVersion(
        input.db,
        input.fs,
        request.skillId,
        {
          kind: 'replace-files',
          files: files
            .filter((file) => file.path !== MAIN)
            .map((file) => ({ path: file.path, content: file.content })),
          mainContent: Buffer.from(mainContent, 'utf8'),
        },
        {
          source: request.versionSource,
          authorUserId: request.authorUserId,
          summary: request.summary,
          fusionId: request.fusionId,
        },
      )
      const handle: StagedSkillTreeVersion = Object.freeze({
        skillId: staged.skillId,
        versionIndex: staged.newVersion,
      })
      stagedVersions.set(handle, {
        staged,
        request,
        description: skillMainDescription(mainContent),
      })
      return handle
    },
    inTransaction(transaction: PersistenceTx) {
      return createSkillVersionCommitParticipantInTx({
        async commit(
          handle: StagedSkillTreeVersion,
          hooks?: SkillVersionCommitHooks<Promise<void> | void>,
        ): Promise<number> {
          const { staged, request, description } = entryOf(handle)
          if (staged.noop !== null) throw new Error('a skill tree version is never a no-op write')
          await hooks?.before?.()
          if (skillVersionCompositeFenceRequested(request)) {
            const live = await readSkillVersionCompositeLive(transaction, staged.skillId)
            if (skillVersionCompositeDrifted(live, request)) {
              throw staleConflictError(
                'skill',
                request.staleMessage ??
                  `skill '${staged.skillId}' changed since this operation started; reload and retry`,
              )
            }
          }
          const plan = planSkillVersionCommit({
            versionRowId: ulid(),
            skillId: staged.skillId,
            versionIndex: staged.newVersion,
            contentHash: staged.newHash,
            filesPath: skillVersionRelPath(staged.skillId, staged.newVersion),
            source: request.versionSource,
            summary: request.summary,
            fusionId: request.fusionId,
            restoredFromVersion: null,
            authorUserId: request.authorUserId,
            now: request.now,
            setDescription: description,
          })
          const { skills, skillVersions } = tablesOf(transaction)
          await transaction.update(skills).set(plan.skillPatch).where(eq(skills.id, staged.skillId))
          await insertOne(transaction, skillVersions, plan.versionRow)
          await hooks?.after?.(staged.newVersion)
          if (staged.opId !== null) await advancePhase(transaction, staged.opId, 'db-committed')
          return staged.newVersion
        },
      })
    },
    async publish(handle: StagedSkillTreeVersion) {
      const { staged } = entryOf(handle)
      // The database already names a generation live content has not published:
      // drop the previous admission first, exactly as `commitSkillVersion` does.
      unmarkSkillBootVerified(staged.skillId)
      await publishStagedSkillVersion(input.db, input.fs, staged)
      stagedVersions.delete(handle)
    },
    async abort(handle: StagedSkillTreeVersion) {
      const entry = stagedVersions.get(handle)
      if (entry === undefined) return
      stagedVersions.delete(handle)
      await abortStagedSkillVersion(input.db, entry.staged, undefined, input.fs.versionContent)
    },
  } satisfies SkillTreeVersionParticipant)
}
