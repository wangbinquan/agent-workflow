// RFC-304 §3.1 — which deliveries start a review round.
//
// The rule has two opposite failure modes and both are expensive:
//
//   too eager — a round per comment on a busy MR. That is how a review bot
//               becomes the thing everyone mutes, and the cost is continuous.
//   too rare  — the author pushes a fix and nothing responds, which reads as
//               the platform being broken rather than as a setting.
//
// The loop guard is the sharpest case here: a round publishes comments, the
// publication is itself an event, and without the guard that event starts the
// next round. It costs money continuously and buries the MR under its own
// output — and every part of it looks like the system working.

import { describe, expect, test } from 'bun:test'
import {
  cellsWokenBy,
  judgeWake,
  subscribedEvents,
  DEFAULT_MR_REVIEW_EVENTS,
  type WakeableCell,
} from '../src/modules/code-capability/domain/capabilityWake'

const cell = (over: Partial<WakeableCell> = {}): WakeableCell => ({
  capability: 'mr-review',
  enabled: true,
  readiness: 'ready',
  triggerConfig: {},
  ...over,
})

const event = (over: Record<string, unknown> = {}) => ({
  eventType: 'mr_opened',
  mrIid: '412',
  ...over,
})

describe('RFC-304 — the default event set is narrow', () => {
  test('an MR appearing wakes a review', () => {
    expect(judgeWake(cell(), event())).toEqual({ wake: true })
  })

  test('an MR changing wakes a review', () => {
    expect(judgeWake(cell(), event({ eventType: 'mr_updated' })).wake).toBe(true)
  })

  test('a comment does NOT wake one by default', () => {
    // Opt-in, not default: a busy MR would otherwise get a round per remark.
    const verdict = judgeWake(cell(), event({ eventType: 'mr_note' }))
    expect(verdict).toEqual({ wake: false, reason: 'event-not-subscribed' })
  })

  test('a plain push does not wake one', () => {
    expect(judgeWake(cell(), event({ eventType: 'push' })).wake).toBe(false)
  })

  test('the default set is exactly the two MR lifecycle events', () => {
    expect(DEFAULT_MR_REVIEW_EVENTS).toEqual(['mr_opened', 'mr_updated'])
  })
})

describe('RFC-304 — a cell can narrow or widen its events', () => {
  test('an explicit list replaces the default', () => {
    const c = cell({ triggerConfig: { events: ['mr_note'] } })
    expect(judgeWake(c, event({ eventType: 'mr_note' })).wake).toBe(true)
    expect(judgeWake(c, event({ eventType: 'mr_opened' })).wake).toBe(false)
  })

  test('an EMPTY list means none, not default', () => {
    // Someone who cleared the list meant to stop it. Restoring the default here
    // would override a deliberate action with a helpful-looking one.
    const c = cell({ triggerConfig: { events: [] } })
    expect(subscribedEvents(c)).toEqual([])
    expect(judgeWake(c, event()).wake).toBe(false)
  })

  test('a malformed list falls back to the default rather than waking on nothing', () => {
    expect(subscribedEvents(cell({ triggerConfig: { events: 'mr_opened' } }))).toEqual(
      DEFAULT_MR_REVIEW_EVENTS,
    )
  })

  test('non-string entries are ignored, not stringified', () => {
    const c = cell({ triggerConfig: { events: ['mr_opened', 42, null] } })
    expect(subscribedEvents(c)).toEqual(['mr_opened'])
  })
})

describe('RFC-304 — what never wakes a round', () => {
  test('a cell that is not ready stays asleep', () => {
    // Same rule as `wantsCapability`: waking a misconfigured cell produces a
    // round that fails later, on the MR, in front of the author.
    expect(judgeWake(cell({ readiness: 'misconfigured' }), event())).toEqual({
      wake: false,
      reason: 'not-ready',
    })
  })

  test('a disabled cell stays asleep even if readiness is stale', () => {
    expect(judgeWake(cell({ enabled: false, readiness: 'ready' }), event()).wake).toBe(false)
  })

  test('an MR-shaped event with no iid cannot be reviewed', () => {
    // Design §6.1: a fork PR's CI event arrives with an empty `pull_requests[]`,
    // so there is nothing to review and nowhere to publish.
    expect(judgeWake(cell(), event({ mrIid: undefined }))).toEqual({ wake: false, reason: 'no-mr' })
    expect(judgeWake(cell(), event({ mrIid: '' })).wake).toBe(false)
  })

  test('the bot’s OWN event never wakes it', () => {
    // The loop guard. A round publishes, the publication is an event, and the
    // next round starts — continuously, and every step looks like it is working.
    const c = cell({ triggerConfig: { events: ['mr_note'] } })
    const verdict = judgeWake(c, event({ eventType: 'mr_note', authorUsername: 'aw-bot' }), {
      botUsername: 'aw-bot',
    })
    expect(verdict).toEqual({ wake: false, reason: 'own-comment' })
  })

  test('someone else’s comment still wakes it when subscribed', () => {
    const c = cell({ triggerConfig: { events: ['mr_note'] } })
    expect(
      judgeWake(c, event({ eventType: 'mr_note', authorUsername: 'a-human' }), {
        botUsername: 'aw-bot',
      }).wake,
    ).toBe(true)
  })

  test('an unconfigured bot name does not silently suppress everyone', () => {
    // A blank bot name must not match a blank author and mute the whole repo.
    expect(judgeWake(cell(), event({ authorUsername: '' }), { botUsername: '' }).wake).toBe(true)
  })
})

describe('RFC-304 — selecting the cells a delivery wakes', () => {
  test('only ready, subscribed cells are woken', () => {
    const woken = cellsWokenBy(
      [
        cell({ capability: 'mr-review' }),
        cell({ capability: 'mr-monitor', readiness: 'misconfigured' }),
      ],
      event(),
    )
    expect(woken.map((c) => c.capability)).toEqual(['mr-review'])
  })

  test('several capabilities on one MR each wake independently', () => {
    const woken = cellsWokenBy([cell({ capability: 'mr-monitor' }), cell()], event())
    expect(woken.map((c) => c.capability)).toEqual(['mr-monitor', 'mr-review'])
  })

  test('the order is stable so two deliveries start rounds the same way', () => {
    const a = cellsWokenBy([cell({ capability: 'z' }), cell({ capability: 'a' })], event())
    const b = cellsWokenBy([cell({ capability: 'a' }), cell({ capability: 'z' })], event())
    expect(a.map((c) => c.capability)).toEqual(b.map((c) => c.capability))
  })

  test('a delivery matching nothing wakes nothing, quietly', () => {
    expect(cellsWokenBy([cell()], event({ eventType: 'push' }))).toEqual([])
  })
})
