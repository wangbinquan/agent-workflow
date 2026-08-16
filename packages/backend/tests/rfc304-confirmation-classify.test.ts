// RFC-304 §6.2 — a reply is only a confirmation when it really is one.
//
// `judgeConfirmation` and `parseConfirmation` shipped with the rest of the
// patch-confirmation design and had ZERO production callers — the stages import
// only the marker helpers. So the platform posted a diff saying "reply
// `/aw apply` to push this", somebody replied, and nothing happened: Guard 3 of
// the transition table says an ordinary `note` never wakes an `awaiting` item,
// and an unclassified reply is exactly an ordinary note.
//
// The domain module names that failure as the worst one available: a person who
// believes they approved a change waits for it, and then stops trusting the
// mechanism. It is also invisible from the platform's side — no error, no round,
// nothing to alert on.
//
// These cases pin the classifier that closes the gap. They are deliberately
// about MEANING rather than mechanism: which replies are commands, which are
// refusals that must be answered, and which are the ordinary comments that make
// up almost all traffic and must stay silent.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeArtifacts, codeWorkItems } from '../src/db/schema'
import { classifyComment } from '../src/modules/code-capability/application/classifyComment'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DIGEST = 'a'.repeat(64)
const HEAD = 'head-sha-000000000000'

describe('RFC-304 — what a reply on the thread means', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(codeWorkItems).values({
      id: 'item-1',
      codeHostEndpointId: 'ep-1',
      stableProjectId: 'proj-1',
      capability: 'mr-comment-fix',
      anchorKind: 'mr',
      anchorId: '412',
      status: 'awaiting',
      epoch: 1,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  afterEach(() => {
    db.$client.close()
  })

  /** A frozen change waiting for a person, at the given generation. */
  const seedPending = async (generation = 1): Promise<void> => {
    await db.insert(codeArtifacts).values({
      id: `art-${String(generation)}`,
      repoPath: '/tmp/repo',
      commitSha: 'commit-abc',
      baseSha: HEAD,
      digest: DIGEST,
      keepRef: 'refs/aw/keep/art',
      roundId: null,
      workItemId: 'item-1',
      generation,
      refCount: 1,
      state: 'live',
      createdAt: 1,
      releasedAt: null,
    })
  }

  const classify = async (body: string) =>
    await classifyComment({ db, workItemId: 'item-1', body, currentHeadSha: HEAD })

  test('`/aw apply` on a waiting change is a CONFIRMATION', async () => {
    // The whole point. Before this classifier existed, this reply was an
    // ordinary note and the item stayed `awaiting` forever.
    await seedPending()
    const verdict = await classify('/aw apply')

    expect(verdict.kind).toBe('confirmation')
    expect(verdict.kind === 'confirmation' && verdict.artifactDigest).toBeTruthy()
    // The generation Guard 2 will compare against.
    expect(verdict.kind === 'confirmation' && verdict.generation).toBe(1)
  })

  test('`/aw push` works too — the design ships two spellings', async () => {
    await seedPending()
    expect((await classify('/aw push')).kind).toBe('confirmation')
  })

  test('an ordinary comment stays ORDINARY', async () => {
    // ~150 comments a day are not instructions. Treating discussion as a
    // command is how a bot pushes code somebody was still arguing about.
    await seedPending()
    for (const body of [
      'I think this approach is wrong',
      'why not apply the other fix?',
      'lgtm',
      'we should apply this pattern everywhere',
    ]) {
      expect((await classify(body)).kind, body).toBe('ordinary')
    }
  })

  test('a confirmation with NOTHING waiting is refused, and says why', async () => {
    // Already pushed, or superseded. Silence here reads as the platform being
    // broken; the reply distinguishes "gone" from "ignored".
    const verdict = await classify('/aw apply')
    expect(verdict.kind).toBe('refused')
    expect(verdict.kind === 'refused' && verdict.message).toContain('no change waiting')
  })

  test('a confirmation naming a DIFFERENT change is refused rather than applied', async () => {
    // The person is answering a diff that is no longer the pending one — most
    // often because they scrolled up to an older comment. Applying the current
    // change instead would push something they never looked at.
    await seedPending()
    const verdict = await classify('/aw apply beefbeefbeef')
    expect(verdict.kind).toBe('refused')
    expect(verdict.kind === 'refused' && verdict.message).toContain('does not match')
  })

  test('a confirmation for a SUPERSEDED generation is refused', async () => {
    // Guard 2's reason, checked before the round is opened: the author pushed
    // between the diff being posted and this reply, so the frozen change was
    // computed against a file that has since moved.
    await seedPending(0)
    const verdict = await classify('/aw apply')
    expect(verdict.kind).toBe('refused')
  })

  test('an empty or unknown work item classifies as ordinary, never throws', async () => {
    // Deliveries arrive for anchors the platform has no item for; that is the
    // ordinary case for an unregistered repository, not an error.
    const verdict = await classifyComment({
      db,
      workItemId: 'nope',
      body: '/aw apply',
      currentHeadSha: HEAD,
    })
    expect(verdict.kind).toBe('ordinary')
  })
})
