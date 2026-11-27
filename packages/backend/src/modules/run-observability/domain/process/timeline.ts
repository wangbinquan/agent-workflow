// RFC-616 §7 — where a unit's wall-clock time went.
//
//   lead   = end − start
//   wait   = length of the union of its human-gate spans, clipped to [start, end]
//   auto   = min(running time, lead)
//   waitEx = min(wait, lead − auto)
//   other  = lead − auto − waitEx
//
// The three parts always add up to `lead`. This is an approximation: waiting is
// only reduced by overlap once running plus waiting exceeds the lead time, i.e.
// the two are assumed to overlap as little as possible. A unit that waits on a
// person in one branch while another branch runs, and is also interrupted,
// shows too much waiting and too little "other". An exact split would need the
// full timeline of task states, which no ledger keeps.

import { PROCESS_GATE_KINDS, type ProcessGateKind } from '@agent-workflow/shared'
import { apportion, sum } from './stats'
import type { ProcessGateRound, ProcessUnit } from './model'

export interface ProcessSpan {
  readonly from: number
  readonly to: number
}

/** Total length covered by the spans (overlaps counted once). */
export function unionLength(spans: readonly ProcessSpan[]): number {
  const sorted = spans
    .filter((span) => span.to > span.from)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  let total = 0
  let end = -Infinity
  for (const span of sorted) {
    if (span.from >= end) {
      total += span.to - span.from
      end = span.to
    } else if (span.to > end) {
      total += span.to - end
      end = span.to
    }
  }
  return total
}

/** The part of a gate round inside the unit's lifetime; null when nothing is left. */
export function gateSpan(
  gate: Pick<ProcessGateRound, 'openedAt' | 'closedAt'>,
  start: number,
  end: number,
): ProcessSpan | null {
  const from = Math.max(gate.openedAt, start)
  // An open gate has waited until the unit ended, or until now.
  const to = Math.min(gate.closedAt ?? end, end)
  return to > from ? { from, to } : null
}

export interface ProcessUnitTime {
  readonly leadMs: number
  /** null: the unit has no running-time record, so auto and other are unknown. */
  readonly autoMs: number | null
  readonly waits: readonly { readonly kind: ProcessGateKind; readonly ms: number }[]
  readonly waitMs: number
  readonly otherMs: number | null
}

/**
 * Split one unit's lead time. `now` closes a unit that is still active. Void
 * gate rounds count: the unit really did wait during them.
 */
export function splitUnitTime(
  unit: Pick<ProcessUnit, 'startedAt' | 'endedAt' | 'autoMs'>,
  gates: readonly Pick<ProcessGateRound, 'kind' | 'openedAt' | 'closedAt'>[],
  now: number,
): ProcessUnitTime {
  const start = unit.startedAt
  const end = Math.max(start, unit.endedAt ?? now)
  const leadMs = end - start

  const byKind = new Map<ProcessGateKind, ProcessSpan[]>()
  const all: ProcessSpan[] = []
  for (const gate of gates) {
    const span = gateSpan(gate, start, end)
    if (span === null) continue
    all.push(span)
    const list = byKind.get(gate.kind)
    if (list) list.push(span)
    else byKind.set(gate.kind, [span])
  }

  const autoMs = unit.autoMs === null ? null : Math.min(Math.max(0, unit.autoMs), leadMs)
  const waitMs = Math.min(unionLength(all), leadMs - (autoMs ?? 0))

  // Per-kind unions can overlap each other; scale them so they add up to waitMs.
  const kinds = PROCESS_GATE_KINDS.filter((kind) => byKind.has(kind))
  const lengths = kinds.map((kind) => unionLength(byKind.get(kind)!))
  const parts = apportion(waitMs, lengths)
  const waits = kinds
    .map((kind, index) => ({ kind, ms: parts[index]! }))
    .filter((wait) => wait.ms > 0)

  return {
    leadMs,
    autoMs,
    waits,
    waitMs: sum(waits.map((wait) => wait.ms)),
    otherMs: autoMs === null ? null : leadMs - autoMs - sum(waits.map((wait) => wait.ms)),
  }
}
