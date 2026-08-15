// RFC-304 T30 — did anyone act on what the review said?
//
// Two signals, kept in separate columns, because they answer different
// questions and disagree in exactly the informative cases:
//
//   resolved      a human marked the thread resolved — an explicit judgement,
//                 including "not a problem, closing this".
//   code_changed  the code under the anchor moved in a later round — evidence
//                 the author acted, whether or not they touched the thread.
//
// A single "adopted" flag would report a quiet fix (changed, never resolved)
// and a disagreement (resolved, unchanged) as the same outcome, which is true
// of one of them.
//
// `code_changed` is deliberately NOT read as "fixed": the review cannot tell a
// fix from a rename, a reformat, or an unrelated edit two lines away. What it
// supports is the honest question — did anything happen where we pointed?

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeFindings } from '../src/db/schema'
import {
  createSqliteFindingLedger,
  markAdoptionSignal,
  readLedgerAnchors,
  type LedgerAnchor,
} from '../src/modules/code-capability/infrastructure/sqliteFindingLedger'
import { detectCodeChanged } from '../src/modules/code-capability/domain/findingReconcile'
import {
  readResolvedFindings,
  withFingerprintMarker,
} from '../src/modules/code-capability/domain/publishReconcileRemote'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ANCHOR: LedgerAnchor = {
  codeHostEndpointId: 'ep-1',
  stableProjectId: '41823',
  anchorKind: 'mr',
  anchorId: '412',
}

describe('RFC-304 — detecting that the code moved', () => {
  test('an anchor that shifted is reported', async () => {
    const changed = detectCodeChanged(
      [{ fingerprint: 'fp-a', anchorLine: 20 }],
      [{ fingerprint: 'fp-a', anchorLine: 11 }],
    )
    expect(changed).toEqual(['fp-a'])
  })

  test('an anchor that did not move is not', async () => {
    expect(
      detectCodeChanged(
        [{ fingerprint: 'fp-a', anchorLine: 11 }],
        [{ fingerprint: 'fp-a', anchorLine: 11 }],
      ),
    ).toEqual([])
  })

  test('a finding seen for the FIRST time is not "changed"', async () => {
    // Nothing to have moved from. Reporting it would mark every new finding as
    // adopted the moment it is published.
    expect(detectCodeChanged([{ fingerprint: 'fp-new', anchorLine: 11 }], [])).toEqual([])
  })

  test('a finding that never had an anchor is skipped, not reported', async () => {
    // It rode the overview. null → a number is a first observation, not drift.
    expect(
      detectCodeChanged(
        [{ fingerprint: 'fp-a', anchorLine: 11 }],
        [{ fingerprint: 'fp-a', anchorLine: null }],
      ),
    ).toEqual([])
  })

  test('a finding that lost its anchor this round is not reported either', async () => {
    // It stopped being placeable — that is an anchoring outcome, not evidence
    // anybody edited the code.
    expect(
      detectCodeChanged(
        [{ fingerprint: 'fp-a', anchorLine: null }],
        [{ fingerprint: 'fp-a', anchorLine: 11 }],
      ),
    ).toEqual([])
  })

  test('the result is ordered, so two identical rounds agree', async () => {
    const changed = detectCodeChanged(
      [
        { fingerprint: 'fp-z', anchorLine: 2 },
        { fingerprint: 'fp-a', anchorLine: 2 },
      ],
      [
        { fingerprint: 'fp-z', anchorLine: 1 },
        { fingerprint: 'fp-a', anchorLine: 1 },
      ],
    )
    expect(changed).toEqual(['fp-a', 'fp-z'])
  })
})

describe('RFC-304 — reading resolutions back from the host', () => {
  const discussion = (id: string, fingerprint: string, resolved: boolean) => ({
    id,
    notes: [{ id: `note-${id}`, body: withFingerprintMarker('a remark', fingerprint), resolved }],
  })

  test('a resolved thread is reported against its finding', async () => {
    const out = readResolvedFindings('gitlab', JSON.stringify([discussion('disc-1', 'fp-a', true)]))
    expect(out.supported).toBe(true)
    expect(out.resolved).toEqual({ 'fp-a': 'disc-1' })
  })

  test('an unresolved thread is not', async () => {
    const out = readResolvedFindings(
      'gitlab',
      JSON.stringify([discussion('disc-1', 'fp-a', false)]),
    )
    expect(out.resolved).toEqual({})
  })

  test('a thread resolved after a reply still counts', async () => {
    // GitLab reports `resolved` per note. Reading only the first would miss
    // every thread somebody replied to before resolving — which is most of them.
    const out = readResolvedFindings(
      'gitlab',
      JSON.stringify([
        {
          id: 'disc-1',
          notes: [
            { id: 'n1', body: withFingerprintMarker('a remark', 'fp-a'), resolved: false },
            { id: 'n2', body: 'you are right, fixed', resolved: true },
          ],
        },
      ]),
    )
    expect(out.resolved).toEqual({ 'fp-a': 'disc-1' })
  })

  test('a human’s own thread is ignored — no marker, not ours', async () => {
    const out = readResolvedFindings(
      'gitlab',
      JSON.stringify([{ id: 'disc-9', notes: [{ id: 'n', body: 'looks good', resolved: true }] }]),
    )
    expect(out.resolved).toEqual({})
  })

  test('GitHub reports UNSUPPORTED rather than "none resolved"', async () => {
    // The REST face does not expose a review thread's resolved state — the same
    // gap that makes `thread.resolve` unsupported there. "We cannot see
    // resolutions" and "nobody resolved anything" must not look alike, or the
    // adoption rate on GitHub would read as a flat zero forever.
    const out = readResolvedFindings('github', JSON.stringify([{ id: 1, body: 'x' }]))
    expect(out.supported).toBe(false)
    expect(out.resolved).toEqual({})
  })

  test('an unreadable body yields nothing rather than throwing', async () => {
    expect(readResolvedFindings('gitlab', 'not json').resolved).toEqual({})
  })
})

describe('RFC-304 — recording adoption', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  const seed = async (fingerprint: string, anchorLine: number | null = 11) => {
    await createSqliteFindingLedger(db, {
      capability: 'mr-review',
      roundId: 'round-1',
      now: () => 1000,
    }).recordPublished({
      anchor: ANCHOR,
      fingerprint,
      generation: 1,
      externalId: 'disc-1',
      ...(anchorLine !== null ? { anchorLine } : {}),
    })
  }

  const rowFor = async (fingerprint: string) => {
    const [row] = await db
      .select()
      .from(codeFindings)
      .where(eq(codeFindings.fingerprint, fingerprint))
    return row
  }

  test('a resolution is stamped with when and by which round', async () => {
    await seed('fp-a')
    expect(
      await markAdoptionSignal({
        db,
        anchor: ANCHOR,
        capability: 'mr-review',
        fingerprint: 'fp-a',
        signal: 'resolved',
        roundId: 'round-2',
        now: 5000,
      }),
    ).toBe(true)

    const row = await rowFor('fp-a')
    expect(row?.resolvedAt).toBe(5000)
    expect(row?.resolvedRoundId).toBe('round-2')
  })

  test('the two signals are independent — one does not set the other', async () => {
    await seed('fp-a')
    await markAdoptionSignal({
      db,
      anchor: ANCHOR,
      capability: 'mr-review',
      fingerprint: 'fp-a',
      signal: 'resolved',
      roundId: 'round-2',
      now: 5000,
    })
    const row = await rowFor('fp-a')
    expect(row?.resolvedAt).toBe(5000)
    // A quiet fix and a disagreement have to remain distinguishable.
    expect(row?.codeChangedAt).toBeNull()
  })

  test('FIRST observation wins — a later round does not overwrite the date', async () => {
    // The value is "when somebody acted". Overwriting each round turns it into
    // "the last time we looked", which answers nothing.
    await seed('fp-a')
    await markAdoptionSignal({
      db,
      anchor: ANCHOR,
      capability: 'mr-review',
      fingerprint: 'fp-a',
      signal: 'resolved',
      roundId: 'round-2',
      now: 5000,
    })
    const second = await markAdoptionSignal({
      db,
      anchor: ANCHOR,
      capability: 'mr-review',
      fingerprint: 'fp-a',
      signal: 'resolved',
      roundId: 'round-3',
      now: 9000,
    })

    expect(second).toBe(false)
    const row = await rowFor('fp-a')
    expect(row?.resolvedAt).toBe(5000)
    expect(row?.resolvedRoundId).toBe('round-2')
  })

  test('another MR’s finding with the same fingerprint is untouched', async () => {
    // The same defect can legitimately appear on two MRs; adoption is per MR.
    await seed('fp-a')
    await createSqliteFindingLedger(db, {
      capability: 'mr-review',
      roundId: 'round-1',
      now: () => 1000,
    }).recordPublished({
      anchor: { ...ANCHOR, anchorId: '999' },
      fingerprint: 'fp-a',
      generation: 1,
      externalId: 'disc-2',
    })

    await markAdoptionSignal({
      db,
      anchor: ANCHOR,
      capability: 'mr-review',
      fingerprint: 'fp-a',
      signal: 'resolved',
      roundId: 'round-2',
      now: 5000,
    })

    const rows = await db.select().from(codeFindings).where(eq(codeFindings.anchorId, '999'))
    expect(rows[0]?.resolvedAt).toBeNull()
  })

  test('readAnchors reports what the ledger last recorded', async () => {
    await seed('fp-a', 11)
    const anchors = await readLedgerAnchors(db, ANCHOR, 'mr-review')
    expect(anchors).toEqual([{ fingerprint: 'fp-a', anchorLine: 11 }])
  })
})
