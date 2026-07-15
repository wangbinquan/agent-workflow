// RFC-192 (T1) — duration formatting + the /tasks duration-cell dispatch.

import { describe, expect, test } from 'vitest'
import { formatDurationMs, taskDurationCell } from '../src/lib/duration'

describe('formatDurationMs — threshold table', () => {
  test('buckets at exact edges; negative clamps to zero', () => {
    expect(formatDurationMs(-5_000)).toEqual({ key: 'sec', opts: { s: 0 } })
    expect(formatDurationMs(0)).toEqual({ key: 'sec', opts: { s: 0 } })
    expect(formatDurationMs(59_999)).toEqual({ key: 'sec', opts: { s: 59 } })
    expect(formatDurationMs(60_000)).toEqual({ key: 'min', opts: { m: 1 } })
    expect(formatDurationMs(59 * 60_000)).toEqual({ key: 'min', opts: { m: 59 } })
    expect(formatDurationMs(60 * 60_000)).toEqual({ key: 'hourMin', opts: { h: 1, m: 0 } })
    expect(formatDurationMs(23 * 3_600_000 + 59 * 60_000)).toEqual({
      key: 'hourMin',
      opts: { h: 23, m: 59 },
    })
    expect(formatDurationMs(24 * 3_600_000)).toEqual({ key: 'dayHour', opts: { d: 1, h: 0 } })
    expect(formatDurationMs(2 * 86_400_000 + 5 * 3_600_000)).toEqual({
      key: 'dayHour',
      opts: { d: 2, h: 5 },
    })
  })
})

describe('taskDurationCell — per-status dispatch', () => {
  const NOW = 1_760_000_000_000
  const base = { startedAt: NOW - 10 * 60_000, finishedAt: null }

  test('terminal rows with finishedAt show the real span', () => {
    for (const status of ['done', 'failed', 'canceled', 'interrupted'] as const) {
      const cell = taskDurationCell(
        { status, startedAt: NOW - 30 * 60_000, finishedAt: NOW - 7 * 60_000 },
        NOW,
      )
      expect(cell).toEqual({ kind: 'finished', dur: { key: 'min', opts: { m: 23 } } })
    }
  })

  test('running → live span; awaiting_* → waiting span', () => {
    expect(taskDurationCell({ ...base, status: 'running' }, NOW)).toEqual({
      kind: 'running',
      dur: { key: 'min', opts: { m: 10 } },
    })
    for (const status of ['awaiting_review', 'awaiting_human'] as const) {
      expect(taskDurationCell({ ...base, status }, NOW)).toEqual({
        kind: 'waiting',
        dur: { key: 'min', opts: { m: 10 } },
      })
    }
  })

  test('pending / terminal-without-finishedAt → dash', () => {
    expect(taskDurationCell({ ...base, status: 'pending' }, NOW)).toEqual({ kind: 'dash' })
    expect(taskDurationCell({ ...base, status: 'interrupted' }, NOW)).toEqual({ kind: 'dash' })
    expect(taskDurationCell({ ...base, status: 'canceled' }, NOW)).toEqual({ kind: 'dash' })
  })
})
