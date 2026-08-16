// RFC-304 §11.2 T59 — the receipt, now that something creates one.
//
// The rule exists because silence on the manual paths does not reduce noise, it
// multiplies it: a reviewer @-mentions the platform, hears nothing for half an
// hour, and @-mentions it again. `mrVoice.answer` implemented the receipt
// exactly as designed and had no production caller, so nobody has ever received
// one — while every automatic failure stayed correctly quiet, which made the
// whole thing look like it worked.
//
// What these pin is the SEPARATION, because that is what is easy to get wrong
// in either direction: a manual instruction is always answered, an automatic
// event never is, and the closing update finds the receipt by the same
// correlation id the troubleshooting chain uses rather than by guessing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeTriggerDeliveries, webhookEndpoints } from '../src/db/schema'
import { triggerSourceOfEvent } from '../src/modules/code-capability/domain/triggerSource'
import { readReceiptMarker } from '../src/modules/code-capability/domain/triggerSource'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

interface FakeHost {
  comments: Array<{ id: string; body: string }>
  actions: string[]
  lastParams: Record<string, unknown>
}
let host: FakeHost

import {
  answerManualInstruction,
  closeReceiptForRound,
} from '../src/modules/code-capability/application/manualReceipt'
import type { CodeHostPort } from '../src/modules/code-capability/ports/codeHostPort'

/**
 * The code host, injected as a PARAMETER.
 *
 * Never `mock.module`: that registry is process-wide and the backend suite
 * shares a process across files, so mocking the adapter here replaced it for
 * every other file in the shard — a dozen unrelated wire-format cases went red
 * the first time this was written that way.
 */
const fakeHost = (): CodeHostPort =>
  ({
    call: async (call: { action: string; params: Record<string, unknown> }) => {
      host.actions.push(call.action)
      host.lastParams = call.params
      if (call.action === 'comment.list') {
        return { ok: true, status: 200, body: JSON.stringify(host.comments), truncated: false }
      }
      if (call.action === 'comment.create') {
        host.comments.push({
          id: `c-${String(host.comments.length)}`,
          body: String(call.params.body),
        })
        return { ok: true, status: 201, body: '{"id":"new"}', truncated: false }
      }
      if (call.action === 'comment.update') {
        const found = host.comments.find((c) => c.id === String(call.params.comment))
        if (found !== undefined) found.body = String(call.params.body)
        return { ok: true, status: 200, body: '{}', truncated: false }
      }
      return { ok: true, status: 200, body: '{}', truncated: false }
    },
  }) as unknown as CodeHostPort

describe('RFC-304 §11.2 — which events a person is waiting on', () => {
  test('a comment is a manual instruction on either host', () => {
    // Both adapters normalise a merge-request comment to `note` and an issue
    // comment to `issue_comment`. Reading the raw GitLab/GitHub names here
    // instead would answer on one host and stay silent on the other.
    expect(triggerSourceOfEvent('note')).toBe('mention')
    expect(triggerSourceOfEvent('issue_comment')).toBe('mention')
    expect(triggerSourceOfEvent('issue_labeled')).toBe('issue-label')
  })

  test('everything the code host emitted on its own is automatic', () => {
    // Pushing a commit IS a human action, and it still gets no receipt: the
    // question is "did somebody address the platform", not "did a person cause
    // this". A comment per red pipeline is exactly what gets a bot muted.
    expect(triggerSourceOfEvent('mr_opened')).toBe('webhook')
    expect(triggerSourceOfEvent('mr_updated')).toBe('webhook')
    expect(triggerSourceOfEvent('pipeline_failed')).toBe('webhook')
  })

  test('a comment does NOT open a receipt at ingress, and that is deliberate', () => {
    // `mr-comment-fix` wakes on ANY note on a merge request, so acknowledging
    // each one would put a machine reply under every line of an ordinary human
    // conversation — the feed §11.1 exists to prevent, produced by the rule
    // meant to help. That capability already answers for itself: it posts an
    // explanation when it declines and the change when it does not.
    //
    // Asserted at source level because the predicate is a private decision of
    // the dispatch path, and the cost of getting it wrong lands on real merge
    // requests rather than in a test.
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'webhook', 'webhookDispatch.ts'),
      'utf8',
    )
    expect(src).toContain("return source === 'issue-label'")
  })

  test('an event type nobody has mapped yet defaults to SILENT', () => {
    // The safe direction. A new manual event that is missing from the mapping
    // shows up as a person not being answered — bad, but recoverable. The other
    // default would put machine comments on every event type we add.
    expect(triggerSourceOfEvent('deployment_finished')).toBe('webhook')
  })
})

describe('RFC-304 T59 — the receipt chain', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    host = { comments: [], actions: [], lastParams: {} }
    await db.insert(webhookEndpoints).values({
      id: 'ep-1',
      name: 'gl',
      provider: 'gitlab',
      urlToken: 'aw_whk_receipt',
      secretEnc: 'sealed',
      enabled: true,
    })
  })
  afterEach(() => db.$client.close())

  const arrive = async (state: Parameters<typeof answerManualInstruction>[0]['state']) =>
    await answerManualInstruction({
      db,
      codeHost: fakeHost(),
      operationId: 'delivery-1',
      endpointId: 'ep-1',
      stableProjectId: '41823',
      anchorKind: 'mr',
      anchorId: '412',
      state,
    })

  test('an instruction is acknowledged the moment it arrives', async () => {
    // Before routing on purpose: "queued behind a lease" and "nobody is
    // listening" look identical from outside, and re-sending into that silence
    // is the behaviour the receipt exists to stop.
    expect(await arrive({ kind: 'received' })).toEqual({ answered: true })
    expect(host.comments).toHaveLength(1)
    expect(host.comments[0]?.body).toContain('Got it')
    expect(readReceiptMarker(host.comments[0]?.body ?? '')).toBe('delivery-1')
  })

  test('every later state EDITS that one comment — the whole exchange costs one ping', async () => {
    await arrive({ kind: 'received' })
    await arrive({ kind: 'running', detail: 'mr-comment-fix' })
    await arrive({ kind: 'done', detail: 'Pushed.' })

    expect(host.comments).toHaveLength(1)
    expect(host.actions.filter((a) => a === 'comment.create')).toHaveLength(1)
    // …and it reads as the CURRENT state, not as a transcript of every state.
    expect(host.comments[0]?.body).toContain('Pushed.')
    expect(host.comments[0]?.body).not.toContain('Got it')
  })

  test('it is addressed to the thread the instruction was typed in', async () => {
    await arrive({ kind: 'received' })
    expect(host.lastParams).toMatchObject({ project: '41823', mr: '412' })
  })

  test('an issue instruction is answered on the ISSUE, not on a merge request', async () => {
    // Same failure either way round: the call is made, the host answers 404,
    // and the person waiting sees nothing at all.
    await answerManualInstruction({
      db,
      codeHost: fakeHost(),
      operationId: 'delivery-2',
      endpointId: 'ep-1',
      stableProjectId: '41823',
      anchorKind: 'issue',
      anchorId: '7',
      state: { kind: 'received' },
    })
    expect(host.lastParams).toMatchObject({ project: '41823', issue: '7' })
    expect(host.lastParams).not.toHaveProperty('mr')
  })

  test('a pipeline anchor is refused by name — nobody typed an instruction at one', async () => {
    const result = await answerManualInstruction({
      db,
      codeHost: fakeHost(),
      operationId: 'd',
      endpointId: 'ep-1',
      stableProjectId: '41823',
      anchorKind: 'pipeline',
      anchorId: '9',
      state: { kind: 'received' },
    })
    expect(result.answered).toBe(false)
    expect(host.actions).toEqual([])
  })

  const seedDelivery = async (over: Partial<typeof codeTriggerDeliveries.$inferInsert> = {}) => {
    await db.insert(codeTriggerDeliveries).values({
      id: 'chain-1',
      correlationId: 'delivery-1',
      codeHostEndpointId: 'ep-1',
      stableProjectId: '41823',
      anchorKind: 'mr',
      anchorId: '412',
      step: 'round',
      outcome: 'ok',
      roundId: 'round-1',
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    } as typeof codeTriggerDeliveries.$inferInsert)
  }

  test('when the round ends, the person’s own receipt is closed', async () => {
    await arrive({ kind: 'received' })
    await seedDelivery()

    const result = await closeReceiptForRound({
      db,
      codeHost: fakeHost(),
      roundId: 'round-1',
      state: { kind: 'done', detail: 'Done — the result is on this merge request.' },
    })

    expect(result).toEqual({ answered: true })
    expect(host.comments).toHaveLength(1)
    expect(host.comments[0]?.body).toContain('Done')
  })

  test('an AUTOMATIC round says nothing, without needing to know it was automatic', async () => {
    // The load-bearing case. No receipt was created at ingress because nobody
    // typed anything, so there is nothing to edit — and `createIfMissing: false`
    // turns that into silence rather than into a fresh comment on every
    // completed webhook round, which is the feed §11.2 exists to prevent.
    await seedDelivery()

    const result = await closeReceiptForRound({
      db,
      codeHost: fakeHost(),
      roundId: 'round-1',
      state: { kind: 'done', detail: 'Done.' },
    })

    expect(result).toEqual({ answered: true })
    expect(host.comments).toEqual([])
    expect(host.actions).not.toContain('comment.create')
  })

  test('a failed round tells the person it failed, rather than leaving “queued” forever', async () => {
    await arrive({ kind: 'received' })
    await seedDelivery()
    await closeReceiptForRound({
      db,
      codeHost: fakeHost(),
      roundId: 'round-1',
      state: { kind: 'failed', detail: 'The round failed; the platform has the details.' },
    })
    expect(host.comments[0]?.body).toContain('did not work')
  })

  test('awaiting does NOT read as a failure — it is a request, not an error', async () => {
    await arrive({ kind: 'received' })
    await seedDelivery()
    await closeReceiptForRound({
      db,
      codeHost: fakeHost(),
      roundId: 'round-1',
      state: { kind: 'awaiting', detail: 'Ready for you: confirm the change and I will push it.' },
    })
    expect(host.comments[0]?.body).toContain('Ready for you')
    expect(host.comments[0]?.body).not.toContain('did not work')
  })

  test('the finalize path actually calls it — the join, locked', async () => {
    // Added after a revert silently deleted this call: an over-greedy edit took
    // the block out, everything still compiled, every unit case above stayed
    // green, and only `--max-warnings 0` noticed the now-unused import. A join
    // with no lock is a join that can vanish without a red test — which is the
    // whole defect class this RFC has been fixing.
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'), 'utf8')
    expect(src).toContain('closeReceiptForRound({')
    // On EVERY terminal outcome, not only the happy one: a person left on
    // "queued" by a failed round is the exact silence §11.2 exists to end.
    expect(src).toContain("outcome === 'awaiting'")
  })

  test('a round with no delivery row is a refusal, not a crash in finalize', async () => {
    // It runs inside `finalizeRound`; throwing here would turn a finished round
    // into a failed one over a comment.
    const result = await closeReceiptForRound({
      db,
      codeHost: fakeHost(),
      roundId: 'round-nobody-knows',
      state: { kind: 'done', detail: 'x' },
    })
    expect(result.answered).toBe(false)
  })

  test('a PROBE delivery has nobody waiting on it', async () => {
    await arrive({ kind: 'received' })
    await seedDelivery({ isProbe: true })
    const result = await closeReceiptForRound({
      db,
      codeHost: fakeHost(),
      roundId: 'round-1',
      state: { kind: 'done', detail: 'x' },
    })
    expect(result.answered).toBe(false)
    // The `received` receipt is the only comment; the probe added nothing.
    expect(host.comments).toHaveLength(1)
    expect(host.comments[0]?.body).toContain('Got it')
  })
})
