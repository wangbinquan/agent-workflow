// RFC-191 (T1) — <RelativeTime> primitive locks.
//
// 1. relativeTimeToken threshold table, BOTH directions (past mirrors
//    lib/homepage.ts#formatRelativeTime; future is the RFC-192 scheduled
//    「下次触发」face). Boundaries are asserted at the exact ms edges.
// 2. Cross-check against the homepage helper so the two implementations can
//    never drift apart (they converge by TEST, not by a code-level delegate —
//    lib/homepage.ts is RFC-190's active battleground; see RFC-191 design §3.3).
// 3. toEpochMs string/number contract (repos' ISO strings; NaN → null).
// 4. The component: em-dash fallback, title/dateTime attrs, and the shared
//    30 s ticker advancing labels on pages with no refetch of their own.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { relativeTimeToken, toEpochMs } from '../src/lib/relative-time'
import { formatRelativeTime } from '../src/lib/homepage'
import { RelativeTime } from '../src/components/RelativeTime'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const NOW = 1_760_000_000_000

describe('relativeTimeToken — threshold table', () => {
  test('past direction: justNow / minAgo / hourAgo / dayAgo at exact edges', () => {
    expect(relativeTimeToken(NOW, NOW)).toEqual({ key: 'justNow' })
    expect(relativeTimeToken(NOW, NOW - 59_999)).toEqual({ key: 'justNow' })
    expect(relativeTimeToken(NOW, NOW - 60_000)).toEqual({ key: 'minAgo', opts: { n: 1 } })
    expect(relativeTimeToken(NOW, NOW - 59 * 60_000)).toEqual({ key: 'minAgo', opts: { n: 59 } })
    expect(relativeTimeToken(NOW, NOW - 60 * 60_000)).toEqual({ key: 'hourAgo', opts: { n: 1 } })
    expect(relativeTimeToken(NOW, NOW - 23 * 3_600_000)).toEqual({
      key: 'hourAgo',
      opts: { n: 23 },
    })
    expect(relativeTimeToken(NOW, NOW - 24 * 3_600_000)).toEqual({ key: 'dayAgo', opts: { n: 1 } })
    expect(relativeTimeToken(NOW, NOW - 30 * 86_400_000)).toEqual({
      key: 'dayAgo',
      opts: { n: 30 },
    })
  })

  test('future direction mirrors the past thresholds (justNow has no "in 0 min")', () => {
    expect(relativeTimeToken(NOW, NOW + 59_999)).toEqual({ key: 'justNow' })
    expect(relativeTimeToken(NOW, NOW + 60_000)).toEqual({ key: 'inMin', opts: { n: 1 } })
    expect(relativeTimeToken(NOW, NOW + 59 * 60_000)).toEqual({ key: 'inMin', opts: { n: 59 } })
    expect(relativeTimeToken(NOW, NOW + 60 * 60_000)).toEqual({ key: 'inHour', opts: { n: 1 } })
    expect(relativeTimeToken(NOW, NOW + 25 * 3_600_000)).toEqual({ key: 'inDay', opts: { n: 1 } })
    expect(relativeTimeToken(NOW, NOW + 5 * 86_400_000)).toEqual({ key: 'inDay', opts: { n: 5 } })
  })

  test('drift lock: past classification matches lib/homepage.ts#formatRelativeTime', () => {
    // One representative delta per bucket + every boundary edge.
    const deltas = [
      0,
      30_000,
      59_999,
      60_000,
      90_000,
      59 * 60_000,
      3_600_000,
      7_200_000,
      23 * 3_600_000,
      24 * 3_600_000,
      86_400_000 * 3,
    ]
    const KEY_MAP: Record<string, string> = {
      relativeJustNow: 'justNow',
      relativeMinAgo: 'minAgo',
      relativeHourAgo: 'hourAgo',
      relativeDayAgo: 'dayAgo',
    }
    for (const dt of deltas) {
      const home = formatRelativeTime(NOW, NOW - dt)
      const mine = relativeTimeToken(NOW, NOW - dt)
      expect(KEY_MAP[home.key], `bucket for dt=${dt}`).toBe(mine.key)
      expect(home.opts?.n, `n for dt=${dt}`).toBe(mine.opts?.n)
    }
  })
})

describe('toEpochMs — number | ISO string contract', () => {
  test('numbers pass through; ISO strings parse; garbage → null', () => {
    expect(toEpochMs(NOW)).toBe(NOW)
    expect(toEpochMs(new Date(NOW).toISOString())).toBe(NOW)
    expect(toEpochMs('not-a-date')).toBeNull()
    expect(toEpochMs(Number.NaN)).toBeNull()
  })
})

describe('<RelativeTime>', () => {
  test('invalid ts renders the em dash (no NaN text, no <time>)', () => {
    render(createElement(RelativeTime, { ts: 'garbage', 'data-testid': 'rt' }))
    const el = screen.getByTestId('rt')
    expect(el.textContent).toBe(enUS.common.emDash)
    expect(el.tagName).not.toBe('TIME')
  })

  test('renders <time> with dateTime + absolute title, and the 30s shared ticker advances the label', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // 50 s ago → "just now"; after the first 30 s tick the delta crosses 60 s.
    render(createElement(RelativeTime, { ts: NOW - 50_000, 'data-testid': 'rt' }))
    const el = screen.getByTestId('rt')
    expect(el.tagName).toBe('TIME')
    expect(el.getAttribute('dateTime')).toBe(new Date(NOW - 50_000).toISOString())
    expect(el.getAttribute('title')).toBe(new Date(NOW - 50_000).toLocaleString())
    expect(el.textContent).toBe('just now')

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByTestId('rt').textContent).toBe('1 min ago')
  })

  test('ticker is shared and stops with the last subscriber (unmount clears the interval)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { unmount } = render(createElement(RelativeTime, { ts: NOW - 50_000 }))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
