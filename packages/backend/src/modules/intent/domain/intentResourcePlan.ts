// RFC-355 T2（RFC-294 W4-E4a）—— 「一个 resolved intent op 变成什么资源变更计划」的**纯判据**。
//
// 这个函数在此之前是**两个 provider 各一份**：`sqliteIntentApplyOperations.ts` L205-248 与
// `postgresqlIntentApplyOperations.ts` L85-128，**逐字节相同，只有形参名 `op` vs `operation` 不同**。
// 它不碰数据库、不碰事务、不碰任何 provider 机制——纯粹是「op + manifest → plan」的映射，
// 属于 domain，不属于任何 provider。
//
// 抄两份的代价是实测过的：本 RFC 的 T1 在同一批文件里发现 apply 层的 changeset 校验已经真的漂了
// （PostgreSQL 校验、SQLite 裸 `JSON.parse`）。判据只要有两份，迟早会漂——差别只在哪一条先漂。

import type { IntentManifestEntry } from '@/services/intent/manifest'
import type { VersionedIntentResourceChangesetPlan } from '@/modules/resource-catalog/public/types'
import type { ResolvedIntentOp } from '@/services/intent/resolveChangeset'
import { ConflictError } from '@/util/errors'

/**
 * 把一个已解析的 op 映射成资源变更计划。
 *
 * - `plugin` 的 `options` 在 wire 上叫 `options`、在计划里叫 `optionsJson`，这里做唯一一次改名；
 * - `update` 必须带住 fence（`manifestEntry.fence`），缺失或 kind 不匹配即 `intent-baseline-stale`
 *   ——**这是本函数唯一会抛的错误**，两个 provider 此前抛的是同一条；
 * - `create` 带 `fromCopy` 与（可解析时的）`copiedFromResourceId`。
 */
export function intentResourcePlanOf(
  op: ResolvedIntentOp,
  manifestByHandle: ReadonlyMap<string, IntentManifestEntry>,
): VersionedIntentResourceChangesetPlan {
  const payload =
    op.resourceType === 'plugin' && 'options' in op.payload
      ? (() => {
          const { options, ...rest } = op.payload
          return { ...rest, optionsJson: options }
        })()
      : op.payload
  if (op.action === 'update') {
    const expectedRevision = op.manifestEntry?.fence
    if (expectedRevision === undefined || expectedRevision.kind !== op.resourceType) {
      throw new ConflictError(
        'intent-baseline-stale',
        `${op.resourceType} fence missing for intent update`,
      )
    }
    return {
      kind: op.resourceType,
      operationId: op.opId,
      action: 'update',
      resourceId: op.resourceId,
      expectedRevision,
      payload,
    } as VersionedIntentResourceChangesetPlan
  }

  const copiedFromResourceId =
    op.copiedFromHandle === undefined
      ? undefined
      : manifestByHandle.get(op.copiedFromHandle)?.resourceId
  return {
    kind: op.resourceType,
    operationId: op.opId,
    action: 'create',
    resourceId: op.resourceId,
    fromCopy: op.fromCopy,
    ...(copiedFromResourceId === undefined ? {} : { copiedFromResourceId }),
    payload,
  } as VersionedIntentResourceChangesetPlan
}
