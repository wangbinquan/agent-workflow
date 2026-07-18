// RFC-159 — scheduled-tasks WS channel: per-frame owner/admin gate.
//
// Every frame carries ownerUserId; the owner + tasks:read:all admins receive it,
// everyone else drops (no DB lookup).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import type { ScheduledTaskWsMessage } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import {
  resetBroadcastersForTests,
  SCHEDULED_TASK_CHANNEL,
  scheduledTaskBroadcaster,
} from '../src/ws/broadcaster'
import { WS_CHANNELS } from '../src/ws/registry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

describe('RFC-159 — scheduled-tasks WS frame gate', () => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  const spec = WS_CHANNELS['scheduled-tasks']
  const gate = spec.frameGate!
  const db = createInMemoryDb(MIGRATIONS)
  const ctx = (a: Actor) => ({ db, actor: a, cache: new Map<string, boolean>() })
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
