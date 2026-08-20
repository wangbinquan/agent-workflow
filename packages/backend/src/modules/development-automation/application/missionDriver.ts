// RFC-310 mission progress driver.
//
// `runMissionReconcile` intentionally performs exactly one durable decision.
// That makes every transition auditable and independently replayable, but it
// is not by itself a production scheduler: requirement materialization,
// repository inspection, upload placement and delivery effects are synchronous
// steps and do not emit an external wake. A caller that invokes only one step
// leaves the mission parked forever after the first successful transition.
//
// The driver keeps the single-step primitive intact and advances only across
// transitions that have already settled synchronously. It stops at every true
// asynchronous boundary (Agent execution, deferred/manual wait, retry), every
// failure/terminal state, or a deduplicated fixed point. The hard step budget
// is a final guard against a bad redispatch cycle; exhausting it records a
// durable hint so the normal daemon sweep can resume without an unbounded
// request/callback stack.

import { ulid } from 'ulid'

import { runMissionReconcile, type ReconcileDeps, type ReconcileOutcome } from './missionReconciler'

export const MISSION_DRIVE_MAX_STEPS = 64

export type MissionDriveStop =
  | 'async-boundary'
  | 'fixed-point'
  | 'terminal'
  | 'failed-or-blocked'
  | 'not-found'
  | 'step-budget'

export interface MissionDriveOutcome {
  readonly steps: number
  readonly stop: MissionDriveStop
  readonly last: ReconcileOutcome
}

function continuationOf(outcome: ReconcileOutcome): boolean {
  if (outcome.kind === 'action-collect') {
    // A settled Agent result changes the durable facts/candidate and the next
    // platform-owned or playbook-owned step can run immediately. A fresh retry
    // has already launched another process. A failed playbook action must also
    // get one more reconcile so its explicit failure target is applied; legacy
    // actions have already blocked the Mission and converge on that next pass.
    return outcome.result.kind === 'action-collected' || outcome.result.kind === 'action-failed'
  }
  if (outcome.kind !== 'decided') return false
  return (
    outcome.handled === 'collected' ||
    outcome.handled === 'placement-done' ||
    outcome.handled === 'readiness-published'
  )
}

function stopOf(outcome: ReconcileOutcome): MissionDriveStop {
  if (outcome.kind === 'not-found') return 'not-found'
  if (outcome.kind === 'terminal-noop') return 'terminal'
  // T81：本条 Mission 仍是终态——后继是**另一条** Mission，本条的推进到此为止。
  if (outcome.kind === 'mission-reopened') return 'terminal'
  if (outcome.kind === 'deduped') return 'fixed-point'
  if (outcome.kind === 'fence-settled') {
    return outcome.result === 'canceled' ? 'terminal' : 'async-boundary'
  }
  if (outcome.kind === 'fence-pending') return 'async-boundary'
  if (outcome.kind === 'action-collect') {
    return outcome.result.kind === 'action-failed' ? 'failed-or-blocked' : 'async-boundary'
  }
  if (outcome.handled === 'terminal') return 'terminal'
  if (outcome.handled === 'blocked' || outcome.handled === 'action-launch-failed') {
    return 'failed-or-blocked'
  }
  return 'async-boundary'
}

export async function driveMission(
  deps: ReconcileDeps,
  missionId: string,
  options: { readonly maxSteps?: number } = {},
): Promise<MissionDriveOutcome> {
  const maxSteps = options.maxSteps ?? MISSION_DRIVE_MAX_STEPS
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error('mission driver maxSteps must be a positive integer')
  }

  let last: ReconcileOutcome = { kind: 'not-found' }
  for (let steps = 1; steps <= maxSteps; steps += 1) {
    last = await runMissionReconcile(deps, missionId)
    if (!continuationOf(last)) return { steps, stop: stopOf(last), last }
  }

  const mission = deps.store.getMission(missionId)
  if (mission !== null) {
    deps.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'mission-driver-budget',
      deliveryKey: `mission-driver-budget:${missionId}:${mission.revision}`,
      now: deps.now(),
    })
  }
  return { steps: maxSteps, stop: 'step-budget', last }
}

/**
 * RFC-310 PR-12 —— 延迟绑定的 drive 句柄。
 *
 * child Mission participant 要能驱动子 Mission，而它自己又是 `ReconcileDeps` 的一部分：
 * 装配期两者必然有一个先于另一个存在。「先声明指针、装配完成后再绑定、未绑定即拒」
 * 是这条互引用关系的生命周期语义，属应用层；composition 只做 `bind`
 * （RFC-294 §2 装配层不写业务分支，由 `rfc310-architecture-lock` 机械锁定）。
 */
export function createDeferredMissionDrive(): {
  readonly bind: (deps: ReconcileDeps) => void
  readonly drive: (missionId: string) => Promise<MissionDriveOutcome>
} {
  let bound: ReconcileDeps | null = null
  return {
    bind: (deps: ReconcileDeps): void => {
      bound = deps
    },
    drive: async (missionId: string): Promise<MissionDriveOutcome> => {
      const deps = bound
      // 装配未完成就被调用 = 接线漏了一步，绝不静默空转。
      if (deps === null) throw new Error('development-automation-composition-incomplete')
      return driveMission(deps, missionId)
    },
  }
}
