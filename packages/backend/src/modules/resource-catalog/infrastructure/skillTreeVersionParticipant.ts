// RFC-370 §10 V20 —— 融合（以及任何「整树替换成下一版」的写入）经 resource-catalog 推进技能版本。
//
// RFC-401 T5：一份实现、两种内容绑定，写入经 skill 写入场景（`skillAtomicApply.ts`）：取技能锁、暂存树并固化版本快照、在提交
// 事务里依次执行调用方的 `before`、唯一 skill 写入参与者（复合栅栏、版本行）与 `after`，提交后发布 live 并清理候选树。提交之后的
// 失败由 AtomicApply 恢复前滚，崩溃恢复与编辑器同一份。
//
// 种子与候选树经 `SkillTreeContentStore`：严格读某一版本的不可变快照（缺失即 null，没有 live 兜底），
// 候选树与技能同生同灭。

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { NotFoundError, ValidationError } from '@/util/errors'

import type { SkillPackageContentEntry } from '../application/skills/packageContentReader'
import type { SkillTreeContentStore } from '../application/skills/treeContentStore'
import type {
  SkillTreeVersionFile,
  SkillTreeVersionOperations,
  SkillTreeVersionStageRequest,
  SkillVersionCommitHooks,
} from '../public/participants'
import { skillMainDescription, type SkillVersionFsOptions } from './legacy/skillVersion'
import { skillApplyContentFor } from './skillApplyContent'
import { createSkillApplyScene } from './skillAtomicApply'

const MAIN = 'SKILL.md'

/** 公共的树操作加上经 skill 写入场景的版本推进；事务只在本 context 的装配之下出现，公共合同不暴露它。 */
export interface SkillTreeVersionParticipant extends SkillTreeVersionOperations {
  applyVersion(
    request: SkillTreeVersionStageRequest,
    hooks?: (transaction: PersistenceTx) => SkillVersionCommitHooks<Promise<void> | void>,
  ): Promise<number>
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
  const scene = createSkillApplyScene({
    db: input.db,
    content: skillApplyContentFor(input.db, {
      appHome: input.fs.appHome,
      ...(input.fs.contentKind === undefined ? {} : { contentKind: input.fs.contentKind }),
      ...(input.fs.versionContent === undefined ? {} : { versionContent: input.fs.versionContent }),
      ...(input.fs.deletionContent === undefined
        ? {}
        : { deletionContent: input.fs.deletionContent }),
      treeContent: input.trees,
    }),
  })

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
    async applyVersion(request, hooks) {
      const files = await sourceFiles(request)
      const description = skillMainDescription(mainContentOf(files))
      const written = await scene.version({
        skillId: request.skillId,
        change: {
          kind: 'replace-files',
          files: files
            .filter((file) => file.path !== MAIN)
            .map((file) => ({ path: file.path, content: file.content })),
          mainContent: files.find((file) => file.path === MAIN)!.content,
        },
        mutation: {
          fence: {
            ...(request.expectedSkillId === undefined
              ? {}
              : { expectedSkillId: request.expectedSkillId }),
            ...(request.expectedVersion === undefined
              ? {}
              : { expectedVersion: request.expectedVersion }),
            ...(request.expectedMetaRevision === undefined
              ? {}
              : { expectedMetaRevision: request.expectedMetaRevision }),
            ...(request.expectedOwnerUserId === undefined
              ? {}
              : { expectedOwnerUserId: request.expectedOwnerUserId }),
            ...(request.expectedAclRevision === undefined
              ? {}
              : { expectedAclRevision: request.expectedAclRevision }),
            ...(request.expectedVisibility === undefined
              ? {}
              : { expectedVisibility: request.expectedVisibility }),
            ...(request.staleMessage === undefined ? {} : { staleMessage: request.staleMessage }),
          },
          source: request.versionSource,
          summary: request.summary,
          fusionId: request.fusionId,
          restoredFromVersion: null,
          authorUserId: request.authorUserId,
          description,
          // 整树替换总是推进一版（融合与导入的既有语义）。
          advance: 'always',
        },
        ...(hooks === undefined ? {} : { hooks }),
        ...(request.cleanupCandidateId === undefined
          ? {}
          : { candidateId: request.cleanupCandidateId }),
      })
      return written.versionIndex
    },
  } satisfies SkillTreeVersionParticipant)
}
