// RFC-310 PR-7 T72（DA 半）—— MR facts 快照 → catalog cells 投影（design §10.1）。
//
// snapshot 由 integration 侧采集（同 head 的 logical snapshot：head/target/
// draft/terminal/mergeability/approvals/threads——跨 head 变化整组丢弃后重来，
// fence 归采集编排）；这里只做纯投影：external-authoritative 事实落 catalog
// leaf，读不到的维度**不产 cell**（indeterminate 语义——规则读到就老实停，
// 不伪造 known false）。结构同形自持 integration 的 snapshot 形状，零跨
// context import。

import type { FactCell } from './factCell'
import type { FactCellValue } from './facts'

/** integration MR facts collector 的快照（结构同形；词表各自持有）。 */
export interface MrFactsSnapshotLike {
  readonly mrRef: string
  readonly headSha: string
  readonly targetSha: string | null
  readonly targetBranch: string | null
  readonly state: 'opened' | 'merged' | 'closed'
  readonly draft: boolean
  readonly mergeableState: 'mergeable' | 'conflict' | 'unknown'
  /** provider 无 approvals 读面（权限/形态）时 null——不产 cell。 */
  readonly approvalHold: boolean | null
  readonly mergedCommitSha: string | null
  readonly mergedAt: string | null
}

function known(value: FactCellValue, sourceRevision: string): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision }
}

/**
 * catalog 七 leaf + `__mr.*` 内部 cells。mr.mergeable 词表 ['yes','no',
 * 'unknown']、mr.terminalState 词表 ['active','merged','closed']（facts.ts
 * catalog 原样，无扩词）。unhandledCount 由台账查询侧算好传入（selectable
 * 语义归 feedbackLedger，不在投影里复算）。
 */
export function projectMrCells(
  snapshot: MrFactsSnapshotLike,
  unhandledCount: number,
  sourceRevision: string,
  collectedAtMs: number,
): Record<string, FactCell<FactCellValue>> {
  const cells: Record<string, FactCell<FactCellValue>> = {
    'mr.exists': known(true, sourceRevision),
    'mr.draft': known(snapshot.draft, sourceRevision),
    'mr.conflict': known(snapshot.mergeableState === 'conflict', sourceRevision),
    'mr.mergeable': known(
      snapshot.mergeableState === 'mergeable'
        ? 'yes'
        : snapshot.mergeableState === 'conflict'
          ? 'no'
          : 'unknown',
      sourceRevision,
    ),
    'mr.unhandledFeedbackCount': known(unhandledCount, sourceRevision),
    'mr.terminalState': known(
      snapshot.state === 'merged' ? 'merged' : snapshot.state === 'closed' ? 'closed' : 'active',
      sourceRevision,
    ),
    '__mr.ref': known(snapshot.mrRef, sourceRevision),
    '__mr.headSha': known(snapshot.headSha, sourceRevision),
    '__mr.state': known(snapshot.state, sourceRevision),
    '__mr.factsCollectedAt': known(String(collectedAtMs), sourceRevision),
  }
  if (snapshot.approvalHold !== null) {
    cells['mr.approvalHold'] = known(snapshot.approvalHold, sourceRevision)
  }
  if (snapshot.targetSha !== null) {
    cells['__mr.targetSha'] = known(snapshot.targetSha, sourceRevision)
  }
  if (snapshot.targetBranch !== null) {
    cells['__mr.targetBranch'] = known(snapshot.targetBranch, sourceRevision)
  }
  if (snapshot.mergedCommitSha !== null) {
    cells['__mr.mergedCommitSha'] = known(snapshot.mergedCommitSha, sourceRevision)
  }
  if (snapshot.mergedAt !== null) {
    cells['__mr.mergedAt'] = known(snapshot.mergedAt, sourceRevision)
  }
  return cells
}
