// RFC-192 (T1) — task duration formatting, pure token shape.
//
// `formatDurationMs` buckets a span into the i18n keys under `common.dur.*`;
// `taskDurationCell` is the /tasks list's per-row dispatch (terminal rows show
// the real span, running/waiting rows show the live span with a prefix, the
// rest render an em dash). now is a parameter — no implicit clock.

import type { TaskStatus, TaskSummary } from '@agent-workflow/shared'

export interface DurationToken {
  key: 'sec' | 'min' | 'hourMin' | 'dayHour'
  opts: Record<string, number>
}

/** Clamp negative spans (clock drift / dirty finishedAt) to zero. */
export function formatDurationMs(ms: number): DurationToken {
  const t = Math.max(0, ms)
  if (t < 60_000) return { key: 'sec', opts: { s: Math.floor(t / 1000) } }
  const mins = Math.floor(t / 60_000)
  if (mins < 60) return { key: 'min', opts: { m: mins } }
  const hours = Math.floor(t / 3_600_000)
  if (hours < 24) return { key: 'hourMin', opts: { h: hours, m: mins - hours * 60 } }
  const days = Math.floor(t / 86_400_000)
  return { key: 'dayHour', opts: { d: days, h: hours - days * 24 } }
}

export type DurationCell =
  | { kind: 'dash' }
  | { kind: 'finished' | 'running' | 'waiting'; dur: DurationToken }

const WAITING: ReadonlySet<TaskStatus> = new Set(['awaiting_review', 'awaiting_human'])

/**
 * /tasks list duration column dispatch:
 *   - terminal row with a real finishedAt → the actual span;
 *   - running → live span (「进行中 · X」);
 *   - awaiting_review / awaiting_human → live span (「等待 X」);
 *   - anything else (pending, terminal rows without finishedAt) → em dash.
 */
export function taskDurationCell(
  row: Pick<TaskSummary, 'status' | 'startedAt' | 'finishedAt'>,
  nowMs: number,
): DurationCell {
  if (row.finishedAt != null) {
    return { kind: 'finished', dur: formatDurationMs(row.finishedAt - row.startedAt) }
  }
  if (row.status === 'running') {
    return { kind: 'running', dur: formatDurationMs(nowMs - row.startedAt) }
  }
  if (WAITING.has(row.status)) {
    return { kind: 'waiting', dur: formatDurationMs(nowMs - row.startedAt) }
  }
  return { kind: 'dash' }
}
