// RFC-401 T5（design §10.2）—— skill 写入场景的 journal、工件编解码与错误。
//
// journal 表 `skill_apply_journal`；claim 在 `atomic_apply_claims`（scene = `skill`）。工件只记录内容 owner 的不透明引用：恢复按
// `contentKind` 选内容存储（本地文件或数据库字节），补偿与前滚都可以在新进程里完成，不依赖内存里的计划。
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { createAtomicApplyCodecRegistry } from '@/platform/atomic-apply/codecRegistry'
import type { AtomicApplyErrors, AtomicApplyJournal } from '@/platform/contracts/atomicApply'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { ConflictError } from '@/util/errors'

export const SKILL_APPLY_SCENE = 'skill' as const
export const SKILL_APPLY_ARTIFACT_VERSION = 1 as const

export type SkillApplyRow = PersistenceTables['skillApplyJournal']['$inferSelect']
export type SkillApplyOperation = 'create' | 'version' | 'delete'

const contentKind = z.enum(['local-file', 'database-bytes'])
const ref = z.string().min(1)

const SkillApplyArtifactSchema = z.discriminatedUnion('kind', [
  // 一个版本的暂存（新建时是 v1，`create` 为 true）：发布引用与 journal 引用都来自内容 owner 的 plan。
  z.strictObject({
    kind: z.literal('skill-version'),
    contentKind,
    skillId: ref,
    version: z.number().int().positive(),
    publicationId: ref,
    liveRef: ref,
    stagingRef: ref,
    versionRef: ref,
    stagingJournalRef: ref,
    versionJournalRef: ref,
    create: z.boolean(),
  }),
  // 删除：整棵根移入 trash；补偿移回，前滚清掉 trash。
  z.strictObject({
    kind: z.literal('skill-delete'),
    contentKind,
    skillId: ref,
    operationId: ref,
    backupJournalRef: ref,
  }),
  // fusion 的候选树：提交后的尾部清理（前滚时丢弃），提交前失败时保留给 fusion 自己的终态处理。
  z.strictObject({
    kind: z.literal('skill-candidate'),
    contentKind,
    skillId: ref,
    candidateId: ref,
  }),
])

export type SkillApplyArtifact = z.infer<typeof SkillApplyArtifactSchema>

export const skillApplyArtifactCodecs = createAtomicApplyCodecRegistry<SkillApplyArtifact>({
  scene: SKILL_APPLY_SCENE,
  writeFormat: 'versioned-envelope',
  currentVersion: SKILL_APPLY_ARTIFACT_VERSION,
  versions: new Map([
    [
      SKILL_APPLY_ARTIFACT_VERSION,
      {
        decode: (value: unknown) => z.array(SkillApplyArtifactSchema).parse(value),
        encode: (artifacts: readonly SkillApplyArtifact[]) =>
          z.array(SkillApplyArtifactSchema).parse(artifacts),
      },
    ],
  ]),
})

/** journal 的 receipt：写入后的技能形状。`outcome` 区分推进了版本与内容不变。 */
const SkillApplyReceiptSchema = z.strictObject({
  skillId: ref,
  operation: z.enum(['create', 'version', 'delete']),
  outcome: z.enum(['committed', 'already-current']),
  contentVersion: z.number().int().nonnegative(),
  metaRevision: z.number().int().nonnegative(),
})
export type SkillApplyReceipt = z.infer<typeof SkillApplyReceiptSchema>
export const skillApplyReceiptCodec = {
  decode: (json: string): SkillApplyReceipt => SkillApplyReceiptSchema.parse(JSON.parse(json)),
  encode: (receipt: SkillApplyReceipt): string =>
    JSON.stringify(SkillApplyReceiptSchema.parse(receipt)),
}

interface Key {
  readonly id: string
}
interface Insert {
  readonly skillId: string
  readonly operation: SkillApplyOperation
}

export function createSkillApplyJournal(
  db: PersistenceDb,
): AtomicApplyJournal<PersistenceTx, Key, Insert, SkillApplyRow> {
  return {
    transaction: (run) => databaseSessionFor(db).transaction(run),
    async find(tx, key) {
      const { skillApplyJournal: table } = tablesOf(tx)
      return first(tx.select().from(table).where(eq(table.id, key.id)))
    },
    async insert(tx, row, data) {
      const { skillApplyJournal: table } = tablesOf(tx)
      return (
        (await first(
          tx
            .insert(table)
            .values({ ...row, ...data })
            .onConflictDoNothing()
            .returning({ id: table.id }),
        )) !== undefined
      )
    },
    async compareAndSet(tx, id, expected, patch) {
      const { skillApplyJournal: table } = tablesOf(tx)
      return (
        (await first(
          tx
            .update(table)
            .set(patch)
            .where(and(eq(table.id, id), eq(table.state, expected)))
            .returning({ id: table.id }),
        )) !== undefined
      )
    },
    list() {
      const { skillApplyJournal } = tablesOf(db)
      return db.select().from(skillApplyJournal)
    },
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const skillApplyErrors: AtomicApplyErrors<SkillApplyRow> = Object.freeze({
  // 幂等键是每次写入新铸的 id，不会重放；两条保留给合同完整性。
  failedReplay: (row: SkillApplyRow) =>
    new ConflictError('skill-apply-failed', row.error ?? 'skill write failed'),
  unsettledReplay: () =>
    new ConflictError('skill-operation-busy', 'skill write is still in progress'),
  claimLost: () => new ConflictError('skill-operation-busy', 'skill write claim was lost'),
  transitionLost: (phase: 'claim' | 'commit' | 'artifact' | 'lease') =>
    new ConflictError(
      'skill-operation-busy',
      `skill write lost its ${phase === 'lease' ? 'lease' : phase} transition`,
    ),
  failed: (error: unknown) => `failed: ${message(error)}`,
  compensationIncomplete: (error: unknown, errors: readonly unknown[]) =>
    `retryable: compensation incomplete after ${message(error)}: ${errors.map(message).join('; ')}`,
  committedIncomplete: 'retryable: committed skill publication incomplete',
})
