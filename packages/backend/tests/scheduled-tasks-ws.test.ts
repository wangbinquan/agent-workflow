// RFC-159 — scheduled-tasks WS channel: per-frame owner/admin gate.
//
// Every frame carries ownerUserId; the owner + tasks:read:all admins receive it,
// everyone else drops (no DB lookup).
import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { ScheduledTaskWsMessage } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'
import {
  resetBroadcastersForTests,
  SCHEDULED_TASK_CHANNEL,
  scheduledTaskBroadcaster,
} from '../src/ws/broadcaster'
import { WS_CHANNELS } from '../src/ws/registry'

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

describeEachProvider('RFC-159 — scheduled-tasks WS frame gate', (harness) => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  const spec = WS_CHANNELS['scheduled-tasks']
  const gate = spec.frameGate!
  // `harness.db` 是**惰性** getter（beforeEach 之后才有库）：在 describe 体里读就是注册期读取，
  // 会抛 `ProviderHarness 只能在 test 体内读取`。`ctx()` 只在用例里被调用，所以把读取推迟到它里面。
  const ctx = (a: Actor) => ({ db: harness.db, actor: a, cache: new Map<string, boolean>() })
  const msg: ScheduledTaskWsMessage = { type: 'scheduled.fired', id: 's1', ownerUserId: 'bob' }

  test('owner receives, stranger drops, admin receives', async () => {
    expect(await gate(ctx(actor('bob')), msg)).toBe(true)
    expect(await gate(ctx(actor('carol')), msg)).toBe(false)
    expect(await gate(ctx(actor('admin', 'admin')), msg)).toBe(true)
  })

  test('path + hello wiring', () => {
    expect(spec.pathRe.test('/ws/scheduled-tasks')).toBe(true)
    expect(spec.helloName({ kind: 'scheduled-tasks' })).toBe('scheduled-tasks')
  })

  test('shared test reset clears scheduled-task subscribers', () => {
    const received: ScheduledTaskWsMessage[] = []
    scheduledTaskBroadcaster.subscribe(SCHEDULED_TASK_CHANNEL, (message) => {
      received.push(message)
    })
    expect(scheduledTaskBroadcaster.subscriberCount(SCHEDULED_TASK_CHANNEL)).toBe(1)

    resetBroadcastersForTests()
    scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, msg)

    expect(scheduledTaskBroadcaster.subscriberCount(SCHEDULED_TASK_CHANNEL)).toBe(0)
    expect(received).toEqual([])
  })
})
