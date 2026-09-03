// RFC-353 T6（RFC-294 W4-E3）—— 「推进一个技能版本」这件事的**纯判据与纯写入计划**。
//
// 在它之前，同一件事在仓里有两处手抄：
//   ① `infrastructure/legacy/skillVersion.ts#commitSkillVersionInTx`（编辑器 / 导入 / 回滚都走它）；
//   ② knowledge-evolution 的融合 `apply()`，SQLite 与 PostgreSQL 各抄一份。
// 三份的字段集合本来一致，但 ② 的复合前置条件只比了 `contentVersion` / `metaRevision`
// 两项，① 还比 `skillId` / owner / aclRevision / visibility ——同一判据抄多份必漂的老毛病
// （`docs/dev-gotchas.md` 已记过一次）。这里把「比什么」和「写什么」各收成一个纯函数，
// 三个调用点共用，provider 只负责「把 live 行读出来」和「把这两条写回去」。

import type { ResourceVisibility, SkillVersionSource } from '@agent-workflow/shared'

/** 事务里读到的技能实时行——两个 provider 各自取数，字段集合由这里裁定。 */
export interface SkillVersionCompositeLive {
  readonly id: string
  readonly contentVersion: number
  readonly metaRevision: number
  readonly ownerUserId: string | null
  readonly aclRevision: number
  readonly visibility: string
}

/** 调用方在授权那一刻看到的技能形状；`undefined` = 该项不设栅栏。 */
export interface SkillVersionCompositeExpectation {
  readonly expectedSkillId?: string
  readonly expectedVersion?: number
  readonly expectedMetaRevision?: number
  readonly expectedOwnerUserId?: string | null
  readonly expectedAclRevision?: number
  readonly expectedVisibility?: ResourceVisibility
  /** 栅栏拦下时的文案；不参与判据，只决定错误里那句话。 */
  readonly staleMessage?: string
}

/** 六项全空 = 调用方没要栅栏，连 live 行都不必读。 */
export function skillVersionCompositeFenceRequested(
  expectation: SkillVersionCompositeExpectation,
): boolean {
  return (
    expectation.expectedSkillId !== undefined ||
    expectation.expectedVersion !== undefined ||
    expectation.expectedMetaRevision !== undefined ||
    expectation.expectedOwnerUserId !== undefined ||
    expectation.expectedAclRevision !== undefined ||
    expectation.expectedVisibility !== undefined
  )
}

/**
 * 复合前置条件是否已漂。`live === null`（技能在事务里已经不见了）同样算漂。
 *
 * 判据逐项与 RFC-170 的原实现等价，唯一变化是「只此一处」：
 * - `expectedSkillId` —— delete→recreate 后 id 变了；
 * - `expectedVersion` / `expectedMetaRevision` —— 内容 / 元数据在 await 窗口里被别人推进；
 * - `expectedOwnerUserId` / `expectedAclRevision` / `expectedVisibility` —— 归属面在窗口里变了，
 *   调用方那一刻的授权已过期，写入按 409 退回让它重新加载。
 */
export function skillVersionCompositeDrifted(
  live: SkillVersionCompositeLive | null | undefined,
  expectation: SkillVersionCompositeExpectation,
): boolean {
  if (!skillVersionCompositeFenceRequested(expectation)) return false
  if (live === null || live === undefined) return true
  return (
    (expectation.expectedSkillId !== undefined && live.id !== expectation.expectedSkillId) ||
    (expectation.expectedMetaRevision !== undefined &&
      live.metaRevision !== expectation.expectedMetaRevision) ||
    (expectation.expectedVersion !== undefined &&
      live.contentVersion !== expectation.expectedVersion) ||
    (expectation.expectedOwnerUserId !== undefined &&
      live.ownerUserId !== expectation.expectedOwnerUserId) ||
    (expectation.expectedAclRevision !== undefined &&
      live.aclRevision !== expectation.expectedAclRevision) ||
    (expectation.expectedVisibility !== undefined &&
      live.visibility !== expectation.expectedVisibility)
  )
}

export interface SkillVersionWritePlanInput {
  readonly versionRowId: string
  readonly skillId: string
  readonly versionIndex: number
  readonly contentHash: string
  /** 版本快照目录的仓内相对路径。由 RC 的 `skillVersionRelPath` 算出并传进来——
   *  路径拼法连同它的 id / 版本号校验只此一处，domain 不再抄一遍。 */
  readonly filesPath: string
  readonly source: SkillVersionSource
  readonly summary: string | null
  readonly fusionId: string | null
  readonly restoredFromVersion: number | null
  readonly authorUserId: string | null
  readonly now: number
  /** 顺带把描述折进同一事务（保持 DB ↔ SKILL.md 一致）；`undefined` = 不动。 */
  readonly setDescription?: string
}

export interface SkillVersionWritePlan {
  readonly skillPatch: {
    readonly contentVersion: number
    readonly updatedAt: number
    readonly versionState: 'snapshot-authoritative'
    readonly description?: string
  }
  readonly versionRow: {
    readonly id: string
    readonly skillId: string
    readonly versionIndex: number
    readonly filesPath: string
    readonly source: SkillVersionSource
    readonly summary: string | null
    readonly fusionId: string | null
    readonly restoredFromVersion: number | null
    readonly authorUserId: string | null
    readonly contentHash: string
    readonly createdAt: number
  }
}

/**
 * 一次版本推进要写的两条：`skills` 的推进补丁 + `skill_versions` 的新行。
 *
 * `versionState: 'snapshot-authoritative'` 是 RFC-170 §invariant④——刚写下的快照**就是**权威，
 * 它不是可选项，所以不出现在入参里。
 */
export function planSkillVersionCommit(input: SkillVersionWritePlanInput): SkillVersionWritePlan {
  const skillPatch: SkillVersionWritePlan['skillPatch'] = {
    contentVersion: input.versionIndex,
    updatedAt: input.now,
    versionState: 'snapshot-authoritative',
    ...(input.setDescription === undefined ? {} : { description: input.setDescription }),
  }
  return {
    skillPatch,
    versionRow: {
      id: input.versionRowId,
      skillId: input.skillId,
      versionIndex: input.versionIndex,
      filesPath: input.filesPath,
      source: input.source,
      summary: input.summary,
      fusionId: input.fusionId,
      restoredFromVersion: input.restoredFromVersion,
      authorUserId: input.authorUserId,
      contentHash: input.contentHash,
      createdAt: input.now,
    },
  }
}
