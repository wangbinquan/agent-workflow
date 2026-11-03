// RFC-401 T4（design §10.1）—— AtomicApply 的持久 claim / lease / fencing。
//
// 每条 apply journal（Intent 的 `intent_apply_journal`、资源包的 `resource_bundle_applies`）一条 claim，主键 `(scene, journal_id)`；
// 两张 journal 表与各自的幂等域不动。前台与恢复走同一份协议：每一次 journal 状态写所在事务先以 `claimed_by + lease_epoch` 为条件
// 续租，0 行即已被接管；恢复只接管租约已过期（或旧版本留下、没有 claim 行）的记录，接管时 `lease_epoch + 1`。committed 之后
// `tail_state = 'pending'`，提交后的尾部完成置 `complete`。
import { column as c, defineContribution, raw, retention } from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('platform/atomic-apply')

const atomicApplyClaimsDefinition = owner.table({
  id: 'atomic_apply_claims',
  schemaSymbol: 'atomicApplyClaims',
  columns: {
    scene: c.text('scene'),
    journalId: c.id('journal_id'),
    claimedBy: c.text('claimed_by'),
    leaseEpoch: c.int('lease_epoch', { default: 1 }),
    claimExpiresAt: c.epochMs('claim_expires_at'),
    tailState: c.enum('tail_state', ['none', 'pending', 'complete'], { default: 'none' }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['scene', 'journal_id'],
  checks: [
    {
      name: 'atomic_apply_claims_lease_epoch_positive',
      expression: raw('"atomic_apply_claims"."lease_epoch" > 0', '"lease_epoch" > 0'),
    },
  ],
  retention: retention.operational,
})

export const atomicApplyClaims = materializeDrizzle(atomicApplyClaimsDefinition).table

export const schemaContribution = {
  owner: 'platform/atomic-apply',
  version: 1,
  tables: [atomicApplyClaimsDefinition],
} as const
