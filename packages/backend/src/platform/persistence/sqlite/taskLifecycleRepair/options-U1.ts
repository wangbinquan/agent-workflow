// RFC-057 — U1 SQLite repair options.
//
// U1 invariant: multiple node_runs share (taskId, nodeId, iteration,
// reviewIteration, clarifyIteration, shardKey) AND are all in
// awaiting_review | awaiting_human. Typical cause: race in the scheduler
// minted a sibling row before the previous one closed.
//
//   - U1.cancel-older-keep-newest  — keep latest by ulid, mark the others
//     `cancel-by-supersede`. Default for the common race shape.
//   - U1.cancel-newer-keep-oldest  — reverse: keep oldest. Use when the
//     operator knows the newer rows were the race error.

import { inArray } from 'drizzle-orm'

import { nodeRuns } from '@/db/schema'
import { transitionNodeRunStatus } from '@/services/lifecycle'

import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

interface U1Detail {
  key?: string
  nodeRunIds: string[]
  statuses?: string[]
}

function parseU1Detail(rc: RepairContext): U1Detail | null {
  const d = rc.alert.detail
  const ids = d['nodeRunIds']
  if (!Array.isArray(ids)) return null
  const strIds = ids.filter((x): x is string => typeof x === 'string')
  if (strIds.length < 2) return null
  const out: U1Detail = { nodeRunIds: strIds }
  if (typeof d['key'] === 'string') out.key = d['key']
  if (Array.isArray(d['statuses'])) {
    out.statuses = (d['statuses'] as unknown[]).filter((s): s is string => typeof s === 'string')
  }
  return out
}

interface CandidateSet {
  ids: string[]
  // sorted ascending (oldest ulid first); ulids sort lexicographically by time
  sortedAsc: string[]
  liveStatuses: Map<string, string>
}

async function loadCandidates(rc: RepairContext, detail: U1Detail): Promise<CandidateSet | null> {
  const rows = await rc.db
    .select({ id: nodeRuns.id, status: nodeRuns.status })
    .from(nodeRuns)
    .where(inArray(nodeRuns.id, detail.nodeRunIds))
  const liveStatuses = new Map(rows.map((r) => [r.id, r.status]))
  // Filter to rows still in {awaiting_review, awaiting_human} — others have
  // already moved on; the invariant violation is stale.
  const stillActive = rows.filter(
    (r) => r.status === 'awaiting_review' || r.status === 'awaiting_human',
  )
  if (stillActive.length < 2) return null
  const ids = stillActive.map((r) => r.id)
  const sortedAsc = [...ids].sort()
  return { ids, sortedAsc, liveStatuses }
}

const U1_CANCEL_OLDER: RepairOptionDef = {
  id: 'U1.cancel-older-keep-newest',
  rule: 'U1',
  labelKey: 'diagnose.repair.U1.cancelOlderKeepNewest.label',
  descriptionKey: 'diagnose.repair.U1.cancelOlderKeepNewest.desc',
  risk: 'low',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    const detail = parseU1Detail(rc)
    if (detail === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.U1.unavailable.detailMissingIds',
        previewSteps: [],
        ctx: {},
      }
    }
    const cands = await loadCandidates(rc, detail)
    if (cands === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.U1.unavailable.notMultipleActive',
        previewSteps: [],
        ctx: {},
      }
    }
    const keep = cands.sortedAsc[cands.sortedAsc.length - 1]!
    const toCancel = cands.sortedAsc.slice(0, -1)
    return {
      available: true,
      previewSteps: [
        `Keep newest (by ulid): ${keep}`,
        ...toCancel.map((id) => `transitionNodeRunStatus(${id}, cancel-by-supersede) → canceled`),
      ],
      ctx: { keep, toCancel, beforeStatuses: Object.fromEntries(cands.liveStatuses) },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const keep = pre.ctx['keep'] as string
    const toCancel = pre.ctx['toCancel'] as string[]
    const beforeStatuses = pre.ctx['beforeStatuses'] as Record<string, string>
    const before = { keep, toCancel, statusesBefore: beforeStatuses }
    for (const id of toCancel) {
      await transitionNodeRunStatus({
        db: rc.db,
        nodeRunId: id,
        event: { kind: 'cancel-by-supersede', reason: 'rfc057-u1-cancel-older' },
        extra: { finishedAt: rc.now() },
      })
    }
    return {
      beforeSnapshot: before,
      afterSnapshot: { keep, canceled: toCancel },
    }
  },
}

const U1_CANCEL_NEWER: RepairOptionDef = {
  id: 'U1.cancel-newer-keep-oldest',
  rule: 'U1',
  labelKey: 'diagnose.repair.U1.cancelNewerKeepOldest.label',
  descriptionKey: 'diagnose.repair.U1.cancelNewerKeepOldest.desc',
  risk: 'medium',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    const detail = parseU1Detail(rc)
    if (detail === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.U1.unavailable.detailMissingIds',
        previewSteps: [],
        ctx: {},
      }
    }
    const cands = await loadCandidates(rc, detail)
    if (cands === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.U1.unavailable.notMultipleActive',
        previewSteps: [],
        ctx: {},
      }
    }
    const keep = cands.sortedAsc[0]!
    const toCancel = cands.sortedAsc.slice(1)
    return {
      available: true,
      previewSteps: [
        `Keep oldest (by ulid): ${keep}`,
        ...toCancel.map((id) => `transitionNodeRunStatus(${id}, cancel-by-supersede) → canceled`),
      ],
      ctx: { keep, toCancel, beforeStatuses: Object.fromEntries(cands.liveStatuses) },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const keep = pre.ctx['keep'] as string
    const toCancel = pre.ctx['toCancel'] as string[]
    const beforeStatuses = pre.ctx['beforeStatuses'] as Record<string, string>
    const before = { keep, toCancel, statusesBefore: beforeStatuses }
    for (const id of toCancel) {
      await transitionNodeRunStatus({
        db: rc.db,
        nodeRunId: id,
        event: { kind: 'cancel-by-supersede', reason: 'rfc057-u1-cancel-newer' },
        extra: { finishedAt: rc.now() },
      })
    }
    return {
      beforeSnapshot: before,
      afterSnapshot: { keep, canceled: toCancel },
    }
  },
}

export const U1_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  U1_CANCEL_OLDER,
  U1_CANCEL_NEWER,
]
